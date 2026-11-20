import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.HARNESS_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "harness-persistence-")), "test.sqlite3");
process.env.DEEPSEEK_API_KEY = "";

test("questions, quoted speech and hypotheticals do not become user facts", async () => {
  const { getOrCreateUser } = await import("@people/users");
  const memory = await import("@memory");
  const db = await import("@infra/db");
  getOrCreateUser("memory-statements", "记忆回归");
  for (const message of ["我喜欢什么？", "我喜欢猫？", "我叫小吴？", "我叫你别走", "我叫啥来着", "以后叫我什么好", "我最近在干嘛", "假如我叫小明，你怎么称呼我", "他说：我喜欢摄影", "“我叫小明”这句台词怎么样？", "你说我喜欢摄影，对吗？"]) {
    assert.deepEqual(memory.extractExplicit("memory-statements", message), [], message);
    assert.deepEqual(memory.extractCandidates("memory-statements", message), [], message);
  }
  memory.extractExplicit("memory-statements", "我喜欢猫，你呢？");
  memory.extractExplicit("memory-statements", "我喜欢哪吒");
  memory.extractExplicit("memory-statements", "我喜欢《十万个为什么》");
  memory.extractCandidates("memory-statements", "我叫小吴，你叫什么？");
  assert.equal(db.one("SELECT count(*) AS n FROM memories WHERE user_id = 'memory-statements'")?.n, 3);
  assert.ok(memory.listMemories("memory-statements").some((item) => String(item.text).includes("猫")));
  assert.equal(db.one("SELECT count(*) AS n FROM memory_candidates WHERE user_id = 'memory-statements'")?.n, 1);
});

test("accepting a memory candidate rolls back its status if memory storage fails", async (t) => {
  const { getOrCreateUser } = await import("@people/users");
  const memory = await import("@memory");
  const db = await import("@infra/db");
  getOrCreateUser("candidate-atomic", "候选回归");
  const id = memory.queueCandidate("candidate-atomic", "用户喜欢摄影", "interest", 0.9);
  db.run("CREATE TRIGGER fail_memory_write BEFORE INSERT ON memories WHEN NEW.user_id = 'candidate-atomic' BEGIN SELECT RAISE(ABORT, 'test memory storage failure'); END");
  t.after(() => db.run("DROP TRIGGER IF EXISTS fail_memory_write"));
  assert.throws(() => memory.reviewCandidate(id, true), /test memory storage failure/);
  assert.equal(db.one("SELECT status FROM memory_candidates WHERE id = ?", id)?.status, "pending");
  db.run("DROP TRIGGER fail_memory_write");
  assert.equal(memory.reviewCandidate(id, true).status, "accepted");
  assert.equal(memory.forUser("candidate-atomic", "摄影").length, 1);
});

test("an older relevant memory remains searchable after more than 100 newer memories", async () => {
  const { getOrCreateUser } = await import("@people/users");
  const memory = await import("@memory");
  getOrCreateUser("long-memory", "长记忆回归");
  const id = memory.remember("long-memory", "用户最喜欢的植物是蓝花楹", "interest", 2);
  for (let index = 0; index < 110; index += 1) memory.remember("long-memory", `近期其他事项${index}`, "fact", 5);
  assert.ok(memory.forUser("long-memory", "蓝花楹", 8).some((item) => item.id === id));
});

test("reminder status questions and declines do not create new proposals", async () => {
  const { getOrCreateUser } = await import("@people/users");
  const reminder = await import("@people/commitments");
  const { conversationContract } = await import("../packages/core/src/conversation/capabilities");
  getOrCreateUser("reminder-queries", "提醒查询");
  for (const message of ["提醒设好了吗", "你提醒我了吗", "我刚才让你提醒我的事呢", "不要提醒我了", "不用提醒我"]) {
    assert.equal(reminder.isReminderRequest(message), false, message);
    assert.equal(reminder.proposeFromMessage("reminder-queries", message), null, message);
  }
  for (const message of ["明天8点提醒我起床", "你能提醒我明天吃饭吗", "到点叫我", "过十分钟提醒一下"]) {
    assert.equal(reminder.isReminderRequest(message), true, message);
    assert.equal(conversationContract(message, []).action, "reminder", message);
  }
  assert.equal(conversationContract("提醒设好了吗", []).action, "reminder");
});

test("reminder due times compare instants across timezone offsets, including existing records", async () => {
  const { getOrCreateUser } = await import("@people/users");
  const reminder = await import("@people/commitments");
  const db = await import("@infra/db");
  const { isoNow } = await import("@shared/time");
  getOrCreateUser("reminder-timezone", "时区回归");
  const future = new Date(Date.now() + 3_600_000).toISOString();
  const past = new Date(Date.now() - 3_600_000).toISOString();
  const futureId = db.run("INSERT INTO commitments(user_id, title, due_at, status, created_at) VALUES('reminder-timezone', '不该提前触发', ?, 'pending', ?)", future, isoNow()).lastId;
  const pastId = db.run("INSERT INTO commitments(user_id, title, due_at, status, created_at) VALUES('reminder-timezone', '已到期', ?, 'pending', ?)", past, isoNow()).lastId;
  const ids = reminder.due().map((row) => row.id);
  assert.ok(!ids.includes(futureId));
  assert.ok(ids.includes(pastId));
  db.run("INSERT INTO channel_configs(channel, enabled, mode, config, updated_at) VALUES('reminder-clock', 1, 'webhook', '{\"url\":\"https://example.test/hook\"}', ?)", isoNow());
  db.run("INSERT INTO identities(user_id, channel, external_id, created_at) VALUES('reminder-timezone', 'reminder-clock', 'clock-user', ?)", isoNow());
  const proposed = reminder.proposeFromMessage("reminder-timezone", "提醒我吃饭")!;
  for (const invalid of ["2031-05-14 08:00:00", "2031-02-30T08:00:00+08:00", "2031-05-14T24:00:00+08:00"]) assert.throws(() => reminder.confirm(proposed.id, invalid));
  const confirmed = reminder.confirm(proposed.id, future);
  assert.equal(Date.parse(confirmed.due_at), Date.parse(isoNow(new Date(future))));
});

test("guard preserves references to the user's life and hypothetical events", async () => {
  const { sanitize } = await import("@prompting/guard");
  for (const reply of ["你买了相机啊，那有空拍给我看", "你已经辞职了，接下来想歇几天吗", "听你说已经搬家了，搬东西累不累", "如果我买了相机，就拿来拍花"]) {
    assert.equal(sanitize(reply, []).text, reply);
  }
  assert.ok(sanitize("我已经搬家了", []).violations.includes("unsupported_world_fact"));
});
