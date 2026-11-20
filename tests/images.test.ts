import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import sharp from "sharp";

process.env.HARNESS_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "harness-images-")), "images.sqlite3");
process.env.HARNESS_ADMIN_TOKEN = "image-test-token";
process.env.DEEPSEEK_API_KEY = "image-test-key";
process.env.DEEPSEEK_MODEL = "deepseek-flash";

async function fixture() {
  const data = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#ff0000" } }).png().toBuffer();
  return { name: "fixture.png", data_url: `data:image/png;base64,${data.toString("base64")}` };
}

async function request(pathname: string, method = "GET", body?: unknown, authorized = true) {
  const { handle } = await import("@gateway");
  return handle(new Request(`http://localhost/api/${pathname}`, {
    method, headers: authorized ? { Authorization: "Bearer image-test-token" } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  }), pathname.split("?")[0].split("/"));
}

describe("chat images", { concurrency: 1 }, () => {
  test("image decoding rejects invalid inputs and normalizes real images", async () => {
    const { prepareImages } = await import("../packages/core/src/conversation/images");
    const image = await fixture();
    const [prepared] = await prepareImages([image]);
    assert.equal(prepared.mime_type, "image/webp");
    assert.equal(prepared.width, 64);
    assert.equal(prepared.height, 48);
    assert.equal((await sharp(prepared.data).metadata()).format, "webp");
    for (const format of ["jpeg", "webp", "gif"] as const) {
      const bytes = await sharp({ create: { width: 32, height: 24, channels: 3, background: "blue" } }).toFormat(format).toBuffer();
      assert.equal((await prepareImages([{ name: `fixture.${format}`, data_url: `data:image/${format};base64,${bytes.toString("base64")}` }]))[0].width, 32);
    }
    await assert.rejects(prepareImages(Array(5).fill(image)), /最多 4/);
    await assert.rejects(prepareImages([{ name: "fake.png", data_url: `data:image/png;base64,${Buffer.from("<svg></svg>").toString("base64")}` }]), /无效|损坏/);
    await assert.rejects(prepareImages([{ name: "truncated.png", data_url: `data:image/png;base64,${Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64")}` }]), /无法读取/);
    await assert.rejects(prepareImages([{ data_url: "http://127.0.0.1/private.png" }]), /不接受外部链接/);
    await assert.rejects(prepareImages([{ data_url: `data:image/png;base64,${"A".repeat(7_000_000)}` }]), /5 MB/);
  });

  test("image-only messages reach the model, persist, survive follow-up and delete with their chat", async (t) => {
    const calls: Array<{ messages: Array<{ role: string; content: any }>; model: string; thinking: { type: string } }> = [];
    t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
      calls.push(JSON.parse(String(options.body)));
      return Response.json({ choices: [{ message: { content: "图里是一个红色的方块。" } }] });
    });
    const db = await import("@infra/db");
    const created = await (await request("chat/conversations", "POST", { name: "图文测试" })).json();
    const id = created.conversation.id;
    const response = await request("chat", "POST", { user_id: id, message: "", images: [await fixture()] });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.provider, "deepseek");
    assert.equal(result.images.length, 1);
    assert.equal(result.decision, "vision_conversation");
    assert.equal(calls[0].model, "deepseek-flash");
    assert.equal(calls[0].thinking.type, "disabled");
    assert.equal("response_format" in calls[0], false);
    const parts = calls[0].messages.at(-1)!.content;
    assert.ok(parts.some((part: any) => part.type === "image_url" && part.image_url.url.startsWith("data:image/webp;base64,")));
    const history = await (await request(`chat/history?user_id=${id}`)).json();
    assert.equal(history.messages[0].content, "");
    assert.equal(history.messages[0].images[0].id, result.images[0].id);
    assert.equal(db.one("SELECT count(*) AS n FROM memories WHERE user_id = ?", id)?.n, 0);
    const imagePath = result.images[0].url.replace("/api/", "");
    assert.equal((await request(imagePath, "GET", undefined, false)).status, 401);
    assert.equal((await request(imagePath.replace(id, "other-user"))).status, 404);
    const loaded = await request(imagePath);
    assert.equal(loaded.headers.get("content-type"), "image/webp");
    assert.ok((await loaded.arrayBuffer()).byteLength > 0);
    await request("chat", "POST", { user_id: id, message: "它是什么颜色？" });
    assert.ok(calls.at(-1)!.messages.slice(0, -1).some((message) => Array.isArray(message.content) && message.content.some((part: any) => part.type === "image_url")));
    assert.equal(typeof calls.at(-1)!.messages.at(-1)!.content, "string");
    const multiple = await request("chat", "POST", { user_id: id, message: "看看这两张图", images: [await fixture(), await fixture()] });
    assert.equal(multiple.status, 200);
    assert.equal((await multiple.json()).images.length, 2);
    assert.equal(calls.at(-1)!.messages.at(-1)!.content.filter((part: any) => part.type === "image_url").length, 2);
    assert.equal((await request(`chat/history?user_id=${id}`, "DELETE")).status, 200);
    assert.equal(db.one("SELECT count(*) AS n FROM message_images")?.n, 0);
    assert.equal((await request(imagePath)).status, 404);
    assert.equal(db.rows("PRAGMA foreign_key_check").length, 0);
  });

  test("failed vision calls do not create fake replies or consume the image draft", async (t) => {
    t.mock.method(globalThis, "fetch", async () => new Response("unavailable", { status: 503 }));
    const db = await import("@infra/db");
    const response = await request("chat", "POST", { user_id: "vision-failure", message: "看看这个", images: [await fixture()] });
    assert.equal(response.status, 502);
    assert.equal(db.one("SELECT count(*) AS n FROM messages WHERE user_id = 'vision-failure'")?.n, 0);
    assert.equal(db.one("SELECT count(*) AS n FROM message_images")?.n, 0);
  });

  test("vision replies that invent professional knowledge are rewritten with images intact", async (t) => {
    const calls: any[] = [];
    t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
      calls.push(JSON.parse(String(options.body)));
      const content = calls.length === 1
        ? "Redis 是缓存，worker 是后台任务。先查看容器日志。"
        : "这个界面我看不太懂，是你刚才忙的那个？";
      return Response.json({ choices: [{ message: { content } }] });
    });
    const response = await request("chat", "POST", { user_id: "role-vision-rewrite", message: "看看这个", images: [await fixture()] });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.dialogue_rewrites, 1);
    assert.equal(result.hard_checks.role_knowledge_boundary, true);
    assert.equal(result.knowledge_issues.length, 0);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.messages.at(-1).content.some((part: any) => part.type === "image_url")));
    // Clean this fixture so subsequent history-budget checks stay independent.
    await request("chat/history?user_id=role-vision-rewrite", "DELETE");
  });

  test("historical images are bounded and scoped to their user and channel", async () => {
    const { getOrCreateUser } = await import("@people/users");
    const { modelHistory, persistImages, prepareImages } = await import("../packages/core/src/conversation/images");
    const db = await import("@infra/db");
    getOrCreateUser("history-images", "历史图片");
    const images = await prepareImages([await fixture()]);
    for (let index = 0; index < 11; index += 1) {
      const id = db.run("INSERT INTO messages(user_id, channel, role, content, created_at) VALUES('history-images', 'web', 'user', ?, '2026-11-13')", `image-${index}`).lastId;
      persistImages(id, images);
    }
    const history = modelHistory("history-images", "web", images);
    assert.equal(history.flatMap((message) => message.images).length, 7);
    assert.equal(history.at(-1)?.images.length, 1);
    assert.equal(history[0].images.length, 0);
    assert.equal(modelHistory("another-user", "web", []).length, 0);
    assert.equal(modelHistory("history-images", "qq", []).length, 0);
  });

  test("vision does not bypass external action checks and rewrites retain the image", async (t) => {
    const calls: any[] = [];
    t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
      calls.push(JSON.parse(String(options.body)));
      return Response.json({ choices: [{ message: { content: calls.length === 1 ? "可以啊，我马上上号陪你玩" : "我这边没法上号组队，游戏画面倒可以跟你聊。" } }] });
    });
    const response = await request("chat", "POST", { user_id: "image-game-contract", message: "王者一会儿一起玩吗", images: [await fixture()] });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.dialogue_rewrites, 1);
    assert.equal(result.hard_checks.executable_commitments, true);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.messages.at(-1).content.some((part: any) => part.type === "image_url")));
  });

  test("an image shared without asking for recommendations is rewritten without losing the image", async (t) => {
    const calls: any[] = [];
    t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
      calls.push(JSON.parse(String(options.body)));
      return Response.json({ choices: [{ message: { content: calls.length === 1 ? "我推荐你选红色那个。" : "红色和蓝色，都看到了。" } }] });
    });
    const response = await request("chat", "POST", { user_id: "image-observe-only", message: "给你看两个杯子，先不用推荐", images: [await fixture()] });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.reply, "红色和蓝色，都看到了。");
    assert.equal(result.dialogue_rewrites, 1);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.messages.at(-1).content.some((part: any) => part.type === "image_url")));
    await request("chat/history?user_id=image-observe-only", "DELETE");
  });

  test("oversized request bodies are rejected before parsing", async () => {
    const { handle } = await import("@gateway");
    const response = await handle(new Request("http://localhost/api/chat", {
      method: "POST", headers: { Authorization: "Bearer image-test-token", "Content-Length": "50000000" }, body: "{}",
    }), ["chat"]);
    assert.equal(response.status, 413);
  });
});
