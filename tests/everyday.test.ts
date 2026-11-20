import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { planDialogue, reviewDialogue } from "../packages/prompting/src/dialogue";

process.env.HARNESS_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "harness-everyday-")), "everyday.sqlite3");
process.env.DEEPSEEK_API_KEY = "";

test("a direct nickname correction retires the old preferred name and survives unrelated memories", async () => {
  const { getOrCreateUser } = await import("@people/users");
  const memory = await import("@memory");
  getOrCreateUser("nickname-change", "聊天 12");
  memory.extractExplicit("nickname-change", "以后叫我老板");
  memory.extractExplicit("nickname-change", "别叫我老板了，就叫我阿远");
  for (let index = 0; index < 30; index += 1) memory.remember("nickname-change", `其他事项${index}`, "fact", 5);
  const active = memory.listMemories("nickname-change").filter((item) => item.status === "active");
  assert.equal(active.filter((item) => item.memory_key === "singleton:address").length, 1);
  assert.match(String(active.find((item) => item.memory_key === "singleton:address")?.text), /阿远/u);
  const context = memory.forUser("nickname-change", "今天吃什么", 8);
  assert.ok(context.some((item) => /address：阿远/u.test(item.text)));
  assert.ok(context.some((item) => /address_avoid：老板$/u.test(item.text)));
  memory.extractExplicit("nickname-change", "还是叫我老板吧");
  const latest = memory.listMemories("nickname-change").filter((item) => item.status === "active");
  assert.ok(latest.some((item) => item.memory_key === "singleton:address" && /老板/u.test(String(item.text))));
  assert.ok(!latest.some((item) => item.kind === "address_avoid" && /老板/u.test(String(item.text))));
});

test("ordinary conversation gets the real clock without an unrelated whole-day schedule", async () => {
  const { compilePrompt } = await import("@prompting");
  const { businessDate } = await import("@shared/time");
  const prompt = compilePrompt({ user: { display_name: "聊天 12" }, memories: [], mood: "平静", events: [], userMessage: "今天几号星期几" });
  assert.ok(prompt.system.includes(businessDate()));
  assert.match(prompt.system, /Asia\/Shanghai|北京时间/u);
  assert.doesNotMatch(prompt.system, /插画工作|整理画稿/u);
});

test("a clear invitation to ask overrides an earlier request to stop asking", () => {
  const history = [{ role: "user", content: "别一直问我了" }, { role: "assistant", content: "好，不问了" }];
  assert.equal(planDialogue("今天有点累", history).maxQuestions, 0);
  assert.equal(planDialogue("现在可以问了，你问吧", history).maxQuestions, 1);
  assert.equal(planDialogue("现在可以问了，你问吧", [...history, { role: "assistant", content: "那你累不累？" }]).maxQuestions, 1);
  assert.equal(planDialogue("你说", [...history, { role: "user", content: "现在可以问了，你问吧" }]).maxQuestions, 1);
});

test("a request for advice replaces an earlier request just to listen", () => {
  const history = [{ role: "user", content: "只想吐槽，别给我建议" }, { role: "assistant", content: "行，你说" }];
  assert.equal(planDialogue("室友半夜外放视频", history).supportMode, "listen");
  assert.equal(planDialogue("还是给我两条建议吧", history).supportMode, "advice");
  assert.equal(planDialogue("现在可以问了，你问吧", history).maxQuestions, 1);
});

test("a pet name can be recalled beyond the recent dialogue window without crossing users", async () => {
  const db = await import("@infra/db");
  const { getOrCreateUser } = await import("@people/users");
  const { recallConversation } = await import("../packages/core/src/conversation/recall");
  getOrCreateUser("pet-recall", "聊天");
  getOrCreateUser("other-pet", "另一聊天");
  db.run("INSERT INTO messages(user_id, channel, role, content, created_at) VALUES('pet-recall', 'web', 'user', '我家橘猫叫米粒', datetime('now'))");
  db.run("INSERT INTO messages(user_id, channel, role, content, created_at) VALUES('other-pet', 'web', 'user', '我家猫叫别人的猫名', datetime('now'))");
  for (let index = 0; index < 80; index += 1) db.run("INSERT INTO messages(user_id, channel, role, content, created_at) VALUES('pet-recall', 'web', 'user', ?, datetime('now'))", `别的话题${index}`);
  const evidence = recallConversation("pet-recall", "web", "还记得我家猫叫什么吗", []).evidence;
  assert.ok(evidence.some((item) => item.content.includes("米粒")));
  assert.ok(evidence.every((item) => !item.content.includes("别人的猫名")));
});

test("venting about a bad day and negated affection are not scored as attacks or affection toward the character", async () => {
  const { getOrCreateUser } = await import("@people/users");
  const { recordInteraction, relationshipEvents } = await import("@people/relationship");
  getOrCreateUser("daily-emotion", "聊天");
  recordInteraction("daily-emotion", "今天烦死了，室友又不打扫");
  assert.doesNotMatch(String(relationshipEvents("daily-emotion")[0].reason), /negative_interaction/u);
  recordInteraction("daily-emotion", "我不讨厌你啊");
  assert.doesNotMatch(String(relationshipEvents("daily-emotion")[0].reason), /negative_interaction/u);
  recordInteraction("daily-emotion", "我没想你，刚才逗你的");
  assert.doesNotMatch(String(relationshipEvents("daily-emotion")[0].reason), /positive_connection/u);
  recordInteraction("daily-emotion", "我老板说我是傻逼");
  assert.doesNotMatch(String(relationshipEvents("daily-emotion")[0].reason), /negative_interaction/u);
  recordInteraction("daily-emotion", "傻逼");
  assert.match(String(relationshipEvents("daily-emotion")[0].reason), /negative_interaction/u);
  recordInteraction("daily-emotion", "你烦死了，别烦我");
  assert.match(String(relationshipEvents("daily-emotion")[0].reason), /negative_interaction/u);
});

test("a delayed extraction of an old nickname cannot override a newer explicit request", async () => {
  const db = await import("@infra/db");
  const { getOrCreateUser } = await import("@people/users");
  const memory = await import("@memory");
  getOrCreateUser("nickname-background", "聊天");
  const old = db.run("INSERT INTO messages(user_id, channel, role, content, created_at) VALUES('nickname-background', 'web', 'user', '以后叫我老板', datetime('now'))").lastId;
  db.run("INSERT INTO messages(user_id, channel, role, content, created_at) VALUES('nickname-background', 'web', 'user', '就叫我阿远', datetime('now'))");
  memory.extractExplicit("nickname-background", "就叫我阿远");
  const candidate = memory.queueCandidate("nickname-background", "用户希望称呼为老板", "address", 0.95, old);
  assert.equal(memory.reviewCandidate(candidate, true).status, "rejected");
  assert.ok(memory.forUser("nickname-background", "称呼").some((item) => /address：阿远/u.test(item.text)));
});

test("recall of a changed preference retrieves its newer degree as well as its former refusal", async () => {
  const db = await import("@infra/db");
  const { getOrCreateUser } = await import("@people/users");
  const { recallConversation } = await import("../packages/core/src/conversation/recall");
  getOrCreateUser("changed-taste", "聊天");
  const write = (content: string) => db.run("INSERT INTO messages(user_id, channel, role, content, created_at) VALUES('changed-taste', 'web', 'user', ?, datetime('now'))", content);
  write("以前我完全不吃辣");
  for (let index = 0; index < 20; index += 1) write(`别的话题${index}`);
  write("现在能吃一点辣了，微辣可以");
  for (let index = 0; index < 80; index += 1) write(`新的话题${index}`);
  db.run("INSERT INTO messages(user_id, channel, role, content, created_at) VALUES('changed-taste', 'qq', 'user', '别的渠道：我完全不能吃辣', datetime('now'))");
  const evidence = recallConversation("changed-taste", "web", "还记得我现在能不能吃辣", []).evidence;
  assert.ok(evidence.some((item) => item.content.includes("微辣可以")));
  assert.ok(evidence.every((item) => !item.content.includes("别的渠道")));
  write("我生日是四月九号");
  for (let index = 0; index < 80; index += 1) write(`其他事项${index}`);
  assert.ok(recallConversation("changed-taste", "web", "我生日是哪天", []).evidence.some((item) => item.content.includes("四月九号")));
});

test("sharing without a request for recommendations does not become an unsolicited choice or interview", () => {
  const message = "给你看我挑的两个杯子，先不用推荐";
  assert.equal(planDialogue(message, []).maxQuestions, 0);
  assert.ok(reviewDialogue(message, [], "我推荐你选红色那个。").length);
  assert.ok(reviewDialogue(message, [], "要我说，红色那个更适合你。").length);
  assert.equal(reviewDialogue(message, [], "红色和蓝色，都看到了。").length, 0);
  assert.equal(reviewDialogue("先不用推荐，第二张是什么颜色", [], "第二张是蓝色的。").length, 0);
  assert.equal(reviewDialogue("现在帮我选一个", [], "我推荐你选红色那个。").length, 0);
});
