import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.HARNESS_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "harness-text-")), "text.sqlite3");
process.env.HARNESS_ADMIN_TOKEN = "text-test-token";
process.env.DEEPSEEK_API_KEY = "text-test-key";
process.env.DEEPSEEK_MODEL = "deepseek-flash";

async function send(userId: string, message: string) {
  const { handle } = await import("@gateway");
  return handle(new Request("http://localhost/api/chat", {
    method: "POST", headers: { Authorization: "Bearer text-test-token" },
    body: JSON.stringify({ user_id: userId, message }),
  }), ["chat"]);
}

async function assertNoTurn(userId: string) {
  const db = await import("@infra/db");
  for (const table of ["messages", "memories", "commitments", "relationship_events"]) {
    assert.equal(db.one(`SELECT count(*) AS n FROM ${table} WHERE user_id = ?`, userId)?.n, 0, table);
  }
  assert.equal(Number(db.one("SELECT interactions FROM relationships WHERE user_id = ?", userId)?.interactions ?? 0), 0);
}

test("provider failures return an error without a fake reply or partial text turn, and can be retried", async (t) => {
  let unavailable = true;
  const calls: any[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    const body = JSON.parse(String(options.body));
    calls.push(body);
    if (unavailable) return new Response("unavailable", { status: 503 });
    return Response.json({ choices: [{ message: { content: body.messages[0].content.includes("检查一条私人角色聊天草稿") ? '{"issues":[]}' : "好，想几点提醒你？" } }] });
  });
  const text = "明天提醒我吃饭，以后叫我小吴";
  assert.equal((await send("retry-text", text)).status, 502);
  await assertNoTurn("retry-text");
  unavailable = false;
  const response = await send("retry-text", text);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.provider, "deepseek");
  assert.equal(result.commitment.status, "proposed");
  assert.equal(result.relationship.interactions, 1);
  assert.equal(result.semantic_review_status, "checked");
  assert.equal(calls[0].thinking.type, "disabled");
  assert.equal(calls[0].max_tokens, 768);
  const db = await import("@infra/db");
  assert.equal(db.one("SELECT count(*) AS n FROM messages WHERE user_id = 'retry-text'")?.n, 2);
  assert.equal(db.one("SELECT count(*) AS n FROM commitments WHERE user_id = 'retry-text'")?.n, 1);
  assert.ok(result.remembered_ids.length > 0);
});

test("truncated model output is not sent as a successful reply", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ choices: [{ message: { content: "我刚才想说" }, finish_reason: "length" }] }));
  assert.equal((await send("truncated-text", "cpdd")).status, 502);
  await assertNoTurn("truncated-text");
});

test("style repair preserves the actual conversation for review without imitating rejected assistant turns", async (t) => {
  const { getOrCreateUser } = await import("@people/users");
  const db = await import("@infra/db");
  getOrCreateUser("style-context", "测试");
  db.run("INSERT INTO messages(user_id, channel, role, content, created_at) VALUES('style-context', 'web', 'assistant', ?, datetime('now'))", "很高兴认识你，想聊什么都行。");
  const calls: any[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    const body = JSON.parse(String(options.body));
    calls.push(body);
    return Response.json({ choices: [{ message: { content: calls.length === 1 ? "刚那句我自己都嫌尬。" : '{"issues":[]}' } }] });
  });
  const response = await send("style-context", "你说话好官方");
  assert.equal(response.status, 200);
  assert.equal(calls[0].messages.some((message: any) => message.role === "assistant"), false);
  assert.match(calls[0].messages[1].content, /很高兴认识你/);
  assert.equal(JSON.parse(calls[1].messages.at(-1).content).conversation[0].role, "assistant");
  assert.equal(db.one("SELECT content FROM messages WHERE user_id = 'style-context' ORDER BY id LIMIT 1")?.content, "很高兴认识你，想聊什么都行。");
});

test("a draft with unresolved dialogue problems is not sent after exhausting rewrites", async (t) => {
  let attempts = 0;
  t.mock.method(globalThis, "fetch", async () => {
    attempts += 1;
    return Response.json({ choices: [{ message: { content: "我可没这业务。" } }] });
  });
  assert.equal((await send("unresolved-text", "cpdd")).status, 502);
  assert.equal(attempts, 3);
  await assertNoTurn("unresolved-text");
});

test("only the selected and checked candidate reaches chat history", async (t) => {
  const requests: any[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    const body = JSON.parse(String(options.body));
    requests.push(body);
    const content = requests.length === 1
      ? JSON.stringify({ replies: ["没有，我平时就这样。", "刚那句我自己都嫌尬。", "那我调整一下表达方式。"] })
      : JSON.stringify({ best_index: 1, issues: [] });
    return Response.json({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  });
  const response = await send("candidate-choice", "你说话好官方");
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.reply, "刚那句我自己都嫌尬。");
  assert.equal(result.candidate_count, 3);
  assert.equal(result.semantic_review_status, "checked");
  assert.deepEqual(JSON.parse(requests[1].messages.at(-1).content).candidates, ["没有，我平时就这样。", "刚那句我自己都嫌尬。"]);
  assert.equal(requests[0].response_format.type, "json_object");
  assert.equal(requests[1].response_format.type, "json_object");
  const db = await import("@infra/db");
  assert.equal(db.one("SELECT content FROM messages WHERE user_id = 'candidate-choice' AND role = 'assistant'")?.content, result.reply);
  assert.equal(db.one("SELECT input_tokens FROM traces WHERE id = ?", result.trace_id)?.input_tokens, 20);
});

test("message pair and extracted state roll back together when storage fails", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    const body = JSON.parse(String(options.body));
    return Response.json({ choices: [{ message: { content: body.messages[0].content.includes("检查一条私人角色聊天草稿") ? '{"issues":[]}' : "好，具体几点？" } }] });
  });
  const db = await import("@infra/db");
  db.run("CREATE TRIGGER fail_assistant BEFORE INSERT ON messages WHEN NEW.user_id = 'atomic-failure' AND NEW.role = 'assistant' BEGIN SELECT RAISE(ABORT, 'test storage failure'); END");
  t.after(() => { db.run("DROP TRIGGER fail_assistant"); });
  assert.equal((await send("atomic-failure", "提醒我吃饭，以后叫我小吴")).status, 500);
  await assertNoTurn("atomic-failure");
});

test("external action candidates are checked before selection and an old false promise is repaired", async (t) => {
  const { getOrCreateUser } = await import("@people/users");
  const db = await import("@infra/db");
  getOrCreateUser("game-contract", "测试");
  for (const [role, content] of [["user", "王者"], ["assistant", "那一会儿你带我c吧"]]) db.run("INSERT INTO messages(user_id, channel, role, content, created_at) VALUES('game-contract', 'web', ?, ?, datetime('now'))", role, content);
  const requests: any[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    const body = JSON.parse(String(options.body)); requests.push(body);
    return Response.json({ choices: [{ message: { content: requests.length === 1
      ? JSON.stringify({ replies: ["可以啊，我马上上号", "我这边没法实际上号组队，刚才答应快了。", "我打得不行，你带我c"] })
      : '{"issues":[]}' } }] });
  });
  const response = await send("game-contract", "一会玩吗");
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.match(result.reply, /没法.*上号/);
  assert.equal(result.hard_checks.executable_commitments, true);
  assert.equal(result.request_contract.action, "game_session");
  assert.equal(result.request_contract.repair_needed, true);
  const checked = JSON.parse(requests[1].messages.at(-1).content);
  assert.equal(checked.verified_capabilities.game_session, false);
  assert.deepEqual(checked.candidates, [result.reply]);
});

test("a trace write failure cannot leave a saved chat behind a failed HTTP response", async (t) => {
  const db = await import("@infra/db");
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    const body = JSON.parse(String(options.body));
    return Response.json({ choices: [{ message: { content: body.messages[0].content.includes("检查一条私人角色聊天草稿") ? '{"issues":[]}' : "好，小吴。" } }] });
  });
  db.run("CREATE TRIGGER fail_trace_write BEFORE INSERT ON traces WHEN NEW.user_id = 'trace-atomic' BEGIN SELECT RAISE(ABORT, 'test trace storage failure'); END");
  t.after(() => db.run("DROP TRIGGER IF EXISTS fail_trace_write"));
  assert.equal((await send("trace-atomic", "以后叫我小吴")).status, 500);
  await assertNoTurn("trace-atomic");
  assert.equal(db.one("SELECT user_id FROM chat_conversations WHERE user_id = 'trace-atomic'"), undefined);
  db.run("DROP TRIGGER fail_trace_write");
  assert.equal((await send("trace-atomic", "以后叫我小吴")).status, 200);
  assert.equal(db.one("SELECT count(*) AS n FROM messages WHERE user_id = 'trace-atomic'")?.n, 2);
});

test("an exhausted model account reports the actionable cause without consuming the draft", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ error: { message: "Insufficient Balance" } }, { status: 402 }));
  const response = await send("no-model-credit", "你好");
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /余额不足/u);
  await assertNoTurn("no-model-credit");
});
