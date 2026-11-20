import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";

process.env.HARNESS_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "harness-")), "test.sqlite3");
process.env.HARNESS_ADMIN_TOKEN = "test-token";
process.env.HARNESS_INTEGRATION_TOKEN = "integration-test-token";
process.env.DEEPSEEK_API_KEY = "";

describe("domain invariants", { concurrency: 1 }, () => {
test("chat history deletion is scoped, preserves memory, and detaches evidence safely", async () => {
  const db = await import("@infra/db");
  const http = await import("@gateway");
  const conversation = await import("@core/conversation");
  const memory = await import("@memory");
  const request = (path: string, method = "GET", body?: unknown) => http.handle(new Request(`http://localhost/api/${path}`, {
    method, headers: { Authorization: "Bearer test-token" }, body: body === undefined ? undefined : JSON.stringify(body),
  }), path.split("?")[0].split("/"));
  const created = await request("chat/conversations", "POST", { name: "删除功能测试" });
  assert.equal(created.status, 201);
  const { conversation: item } = await created.json() as { conversation: { id: string } };
  await conversation.chat(item.id, "删除功能测试", "以后叫我小雨");
  await conversation.chat(item.id, "删除功能测试", "你好", "qq");
  await conversation.chat("history-other", "另一段聊天", "你好");
  const messageId = db.one("SELECT id FROM messages WHERE user_id = ? AND channel = 'web' AND role = 'user'", item.id)!.id;
  db.run("INSERT INTO memory_extraction_runs(message_id, status, processed_at) VALUES(?, 'completed', '2026-11-13')", messageId);
  db.run("INSERT INTO memory_candidates(user_id, text, source_message_id, created_at) VALUES(?, '候选', ?, '2026-11-13')", item.id, messageId);
  db.run("INSERT INTO commitments(user_id, title, source_message_id, created_at) VALUES(?, '提醒', ?, '2026-11-13')", item.id, messageId);
  const cleared = await request(`chat/history?user_id=${item.id}`, "DELETE");
  assert.equal(cleared.status, 200);
  assert.equal(Number(db.one("SELECT count(*) AS n FROM messages WHERE user_id = ? AND channel = 'web'", item.id)?.n), 0);
  assert.equal(Number(db.one("SELECT count(*) AS n FROM messages WHERE user_id = ? AND channel = 'qq'", item.id)?.n), 2);
  assert.equal(Number(db.one("SELECT count(*) AS n FROM messages WHERE user_id = 'history-other'")?.n), 2);
  assert.ok(db.one("SELECT user_id FROM chat_conversations WHERE user_id = ?", item.id));
  assert.ok(memory.listMemories(item.id).length);
  assert.equal(db.one("SELECT source_message_id FROM relationship_events WHERE user_id = ? ORDER BY id LIMIT 1", item.id)?.source_message_id, null);
  assert.equal(db.one("SELECT source_message_id FROM memory_candidates WHERE user_id = ?", item.id)?.source_message_id, null);
  assert.equal(db.one("SELECT source_message_id FROM commitments WHERE user_id = ?", item.id)?.source_message_id, null);
  assert.equal(db.one("SELECT message_id FROM memory_extraction_runs WHERE message_id = ?", messageId), undefined);
  const removed = await request(`chat/conversations?user_id=${item.id}`, "DELETE");
  assert.equal(removed.status, 200);
  const listed = await (await request("chat/conversations")).json() as { conversations: Array<{ id: string }> };
  assert.equal(listed.conversations.some((entry) => entry.id === item.id), false);
  assert.ok(db.one("SELECT id FROM users WHERE id = ?", item.id));
  assert.equal(db.rows("PRAGMA foreign_key_check").length, 0);
  assert.equal((await request("chat/conversations?user_id=missing", "DELETE")).status, 404);
  assert.equal((await request("chat/conversations", "DELETE")).status, 400);
  const denied = await http.handle(new Request("http://localhost/api/chat/conversations?user_id=history-other", { method: "DELETE" }), ["chat", "conversations"]);
  assert.equal(denied.status, 401);
});

test("deleting a chat waits for a pending reply and leaves no reappearing messages", async () => {
  const conversation = await import("@core/conversation");
  const history = await import("../packages/core/src/conversation/history");
  const db = await import("@infra/db");
  const item = history.createConversation("并发删除测试");
  await Promise.all([
    conversation.chat(item.id, "并发删除测试", "你好"),
    conversation.deleteChatHistory(item.id, true),
  ]);
  assert.equal(db.one("SELECT id FROM messages WHERE user_id = ?", item.id), undefined);
  assert.equal(db.one("SELECT id FROM traces WHERE user_id = ?", item.id), undefined);
  assert.equal(history.listConversations().some((entry) => entry.id === item.id), false);
});

test("private memories never cross users", async () => {
  const users = await import("@people/users");
  const memory = await import("@memory");
  users.getOrCreateUser("alice", "甲");
  users.getOrCreateUser("bob", "乙");
  memory.remember("alice", "用户明确表示interest：摄影", "interest", 4);
  assert.equal(memory.forUser("bob", "摄影").length, 0);
  assert.equal(memory.forUser("alice", "摄影").length, 1);
});

test("singleton user preferences supersede old values and record retrieval use", async () => {
  const users = await import("@people/users");
  const memory = await import("@memory");
  const db = await import("@infra/db");
  users.getOrCreateUser("preference-user", "偏好测试");
  memory.extractExplicit("preference-user", "以后叫我小林");
  memory.extractExplicit("preference-user", "以后叫我阿林");
  const active = memory.listMemories("preference-user").filter((item) => item.status === "active" && item.memory_key === "singleton:address");
  assert.equal(active.length, 1);
  assert.match(String(active[0]?.text), /阿林/);
  assert.equal(memory.listMemories("preference-user").some((item) => item.status === "superseded" && String(item.text).includes("小林")), true);
  memory.forUser("preference-user", "怎么称呼", 3);
  assert.ok(Number(db.one("SELECT access_count FROM memories WHERE id = ?", active[0]?.id)?.access_count ?? 0) >= 1);
});

test("an explicit preference is stored and a chat cannot rewrite the world", async () => {
  const users = await import("@people/users");
  const memory = await import("@memory");
  const chat = await import("@core/conversation");
  const world = await import("@world/daily-life");
  users.getOrCreateUser("carol", "丙");
  const before = world.events().length;
  const result = await chat.chat("carol", "丙", "以后不要叫我老板");
  assert.match(result.reply, /记住|听到/);
  assert.ok(memory.forUser("carol", "老板").some((item) => item.text.includes("address")));
  assert.equal(world.events().length, before);
});

test("relationship changes are evidence-based and exposed as a stage", async () => {
  const users = await import("@people/users");
  const relationship = await import("@people/relationship");
  users.getOrCreateUser("relationship-user", "关系测试");
  const initial = relationship.recordInteraction("relationship-user", "你好");
  const warm = relationship.recordInteraction("relationship-user", "谢谢你，我很喜欢和你聊");
  const disclosure = relationship.recordInteraction("relationship-user", "其实我有点难过，只告诉你");
  const negative = relationship.recordInteraction("relationship-user", "别烦我");
  assert.ok(Number(warm.closeness) > Number(initial.closeness));
  assert.ok(Number(disclosure.trust) > Number(warm.trust));
  assert.ok(Number(negative.closeness) < Number(disclosure.closeness));
  assert.equal(typeof negative.stage, "string");
  assert.equal(relationship.relationshipEvents("relationship-user").length, 4);
});

test("quiet hours and narration stay enforced", async () => {
  const social = await import("@core/social");
  const guard = await import("@prompting/guard");
  const evaluation = await import("@evaluation");
  const quiet = social.canProactivelyContact({ proactive_enabled: 1, quiet_start: "22:00", quiet_end: "08:00", unanswered_count: 0 }, 23);
  assert.equal(quiet.allowed, false);
  const cleaned = guard.sanitize("（轻轻叹气）买了相机", []);
  assert.equal(cleaned.violations.includes("narration_removed"), true);
  assert.equal(cleaned.violations.includes("unsupported_world_fact"), true);
  assert.doesNotMatch(cleaned.text, /买了相机/);
  assert.equal(evaluation.hardChecks("这个账本里没有记录").no_system_leak, false);
  assert.equal(evaluation.hardChecks("嗯嗯，我听着呢。").no_canned_reply, false);
  assert.equal(evaluation.hardChecks("这个我不太确定，今天没特别记这件事。").no_system_leak, true);
});

test("admin session is a cookie and health stays public", async () => {
  const http = await import("@gateway");
  const health = await http.handle(new Request("http://localhost/api/health"), ["health"]);
  assert.equal(health.status, 200);
  const denied = await http.handle(new Request("http://localhost/api/dashboard"), ["dashboard"]);
  assert.equal(denied.status, 401);
  const session = await http.handle(new Request("http://localhost/api/session", { method: "POST", body: JSON.stringify({ token: "test-token" }) }), ["session"]);
  assert.equal(session.status, 200);
  assert.match(session.headers.get("set-cookie") ?? "", /HttpOnly/);
});

test("global immersive mode is enabled and compiled into every prompt", async () => {
  const prompting = await import("@prompting");
  const db = await import("@infra/db");
  assert.equal(String(db.one("SELECT value FROM settings WHERE key = 'immersive_mode'")?.value), "true");
  const compiled = prompting.compilePrompt({
    user: { display_name: "沉浸测试" }, memories: [], events: [], worldFacts: [], mood: "平静",
  });
  assert.match(compiled.system, /全局沉浸模式/);
  assert.match(compiled.system, /始终以林知夏第一人称/);
  assert.doesNotMatch(compiled.system, /【透明模式】/);
});

test("small talk omits irrelevant daily context but an activity question can read it", async () => {
  const { compilePrompt } = await import("@prompting");
  const context = {
    user: { display_name: "测试" }, memories: [{ text: "用户希望被叫阿明" }],
    events: [{ title: "验收专用画稿任务", details: "只为检验按需注入", status: "ongoing", start_time: "09:00" }],
    goals: [{ title: "验收专用目标", status: "active", progress: 10 }],
    mood: "平静",
  };
  for (const userMessage of ["你好", "还好"]) {
    const prompt = compilePrompt({ ...context, userMessage }).system;
    assert.doesNotMatch(prompt, /验收专用画稿任务|验收专用目标/);
    assert.match(prompt, /阿明/);
  }
  assert.match(compilePrompt({ ...context, userMessage: "你在干嘛" }).system, /验收专用画稿任务/);
});

test("casual social turns keep personal facts but do not inject operational restrictions or numeric scores", async () => {
  const { compilePrompt } = await import("@prompting");
  const compiled = compilePrompt({
    user: { display_name: "测试" }, memories: [], events: [], mood: "平静", userMessage: "你有对象吗",
    relationship: { stage: "new", closeness: 5, trust: 10, interactions: 4 },
  }).system;
  assert.match(compiled, /单身/);
  assert.doesNotMatch(compiled, /本轮没有已验证的可执行动作|亲近度 5|互动 4 次/);
  const action = compilePrompt({ user: { display_name: "测试" }, memories: [], events: [], mood: "平静", userMessage: "提醒我喝水", capabilityNote: "准确时间尚未确认，不能说已设置" }).system;
  assert.match(action, /准确时间尚未确认/);
});

test("obsolete lore cannot override the currently published character biography", async () => {
  const { portrait } = await import("@character");
  const { compilePrompt } = await import("@prompting");
  const role = portrait();
  const system = compilePrompt({ user: { display_name: "测试" }, memories: [], events: [], mood: "平静", userMessage: "你是做什么的，有什么喜好？", worldFacts: [
    { scope: "character", subject: role.name, predicate: "职业", object: "旧版错误职业验收标记" },
    { scope: "character", subject: role.name, predicate: "喜好", object: "保留独立设定验收标记" },
  ] }).system;
  assert.doesNotMatch(system, /旧版错误职业验收标记/);
  assert.match(system, /保留独立设定验收标记/);
  assert.ok(system.includes(role.occupation));
});

test("channel integrations use their own token and cannot perform admin review", async () => {
  const http = await import("@gateway");
  const denied = await http.handle(new Request("http://localhost/api/integrations/messages", {
    method: "POST",
    body: JSON.stringify({ channel: "qq", external_user_id: "openid-1", message: "你好" }),
  }), ["integrations", "messages"]);
  assert.equal(denied.status, 401);
  const accepted = await http.handle(new Request("http://localhost/api/integrations/messages", {
    method: "POST",
    headers: { Authorization: "Bearer integration-test-token" },
    body: JSON.stringify({ channel: "qq", external_user_id: "openid-1", display_name: "QQ 用户", message: "你好" }),
  }), ["integrations", "messages"]);
  assert.equal(accepted.status, 200);
  const reply = await accepted.json() as { reply?: string };
  assert.ok(reply.reply);
  const cannotReview = await http.handle(new Request("http://localhost/api/integrations/events/review", {
    method: "POST",
    headers: { Authorization: "Bearer integration-test-token" },
    body: JSON.stringify({ id: 1, decision: "reject" }),
  }), ["integrations", "events", "review"]);
  assert.equal(cannotReview.status, 401);
});

test("operations health marks stale worker heartbeats offline", async () => {
  const db = await import("@infra/db");
  const http = await import("@gateway");
  db.run(
    `INSERT INTO worker_heartbeats(worker_id, started_at, last_seen_at, status)
     VALUES('stale-worker', '2020-01-01T00:00:00+08:00', '2020-01-01T00:00:00+08:00', 'running')`,
  );
  const response = await http.handle(new Request("http://localhost/api/operations/health", {
    headers: { Authorization: "Bearer test-token" },
  }), ["operations", "health"]);
  assert.equal(response.status, 200);
  const body = await response.json() as { workers: Array<{ worker_id: string; effective_status: string }> };
  assert.equal(body.workers.find((item) => item.worker_id === "stale-worker")?.effective_status, "offline");
});

test("character changes are versioned and growth requires repeated evidence", async () => {
  const character = await import("@character");
  const original = character.active();
  assert.throws(
    () => character.addGrowthEvidence("personality", "冲动", "2026-11-01", "一次观察"),
    /核心人格/,
  );
  character.addGrowthEvidence("hobby_style", "更关注城市光影", "2026-11-01", "完成夜景练习");
  assert.throws(() => character.applyGrowth("hobby_style", "更关注城市光影"), /两个不同日期/);
  character.addGrowthEvidence("hobby_style", "更关注城市光影", "2026-11-08", "再次主动安排夜景练习");
  const draftId = character.applyGrowth("hobby_style", "更关注城市光影");
  assert.equal(character.active().id, original.id, "growth must not mutate the published version");
  character.publish(draftId);
  assert.equal(character.portrait().growth.hobby_style, "更关注城市光影");
});

test("publishing a character updates generated biography facts without erasing the old version", async () => {
  const character = await import("@character");
  const db = await import("@infra/db");
  const original = character.active();
  const occupation = original.profile.occupation === "大学生" ? "独立插画师" : "大学生";
  const id = character.createDraft("职业一致性测试", { ...original.profile, occupation });
  character.publish(id);
  assert.equal(db.one("SELECT object FROM world_facts WHERE subject = ? AND predicate = '职业' AND status = 'active'", original.profile.name)?.object, occupation);
  assert.ok(db.one("SELECT id FROM world_facts WHERE subject = ? AND predicate = '职业' AND status = 'superseded'", original.profile.name));
  character.publish(original.id);
});

test("daily planning is deterministic, conflict-aware, and idempotent", async () => {
  const world = await import("@world/daily-life");
  world.saveScheduleTemplate({
    weekday: null,
    startTime: "06:34",
    endTime: "07:15",
    title: "测试固定午间安排",
    probability: 1,
  });
  const first = world.ensureDailySkeleton("2031-05-10", "sandbox");
  const second = world.ensureDailySkeleton("2031-05-10", "sandbox");
  assert.deepEqual(second.map((item) => item.id), first.map((item) => item.id));
  assert.equal(first.filter((item) => item.title === "测试固定午间安排").length, 1);
  assert.equal(world.hasConflict("2031-05-10", "06:45", "07:00", "sandbox"), true);
});

test("world events move from planned to ongoing to completed", async () => {
  const world = await import("@world/daily-life");
  const id = world.addEvent({ title: "有结束时间的测试事件", day: "2031-05-08", startTime: "10:00", endTime: "11:00" });
  assert.deepEqual(world.transitionDue("2031-05-08", "10:30"), { started: 1, completed: 0 });
  assert.equal(world.events("2031-05-08").find((item) => item.id === id)?.status, "ongoing");
  assert.deepEqual(world.transitionDue("2031-05-08", "11:01"), { started: 0, completed: 1 });
  assert.equal(world.events("2031-05-08").find((item) => item.id === id)?.status, "completed");
});

test("world lore conflicts require review and only active facts enter context", async () => {
  const lore = await import("@world/lore");
  const context = await import("@core/context");
  const users = await import("@people/users");
  users.getOrCreateUser("lore-user", "世界观测试");
  const current = lore.activeFacts().find((item) => item.subject === "林知夏" && item.predicate === "常住城市");
  assert.equal(current?.object, "杭州");
  const proposal = lore.proposeFact({ subject: "林知夏", predicate: "常住城市", object: "上海", scope: "character", source: "test" });
  assert.equal(proposal.status, "proposed");
  assert.equal(proposal.conflict_with, current?.id);
  assert.equal(lore.activeFacts().find((item) => item.subject === "林知夏" && item.predicate === "常住城市")?.object, "杭州");
  lore.reviewFact(proposal.id, true);
  assert.equal(lore.activeFacts().find((item) => item.subject === "林知夏" && item.predicate === "常住城市")?.object, "上海");
  assert.equal(context.buildContext("lore-user", "住在哪里").world_facts.some((item) => item.object === "上海"), true);
});

test("reviewed external events stay private to their owner", async () => {
  const users = await import("@people/users");
  const external = await import("@channels/external");
  const world = await import("@world/daily-life");
  users.getOrCreateUser("external-owner", "外部事件用户");
  users.getOrCreateUser("external-other", "其他用户");
  const received = external.receive({
    source: "calendar-test",
    externalId: "event-private-1",
    userId: "external-owner",
    eventType: "calendar",
    payload: { title: "私人复诊", date: "2031-05-07", start_time: "10:00" },
  });
  assert.equal("id" in received, true);
  if (!("id" in received)) throw new Error("event was unexpectedly duplicated");
  external.review(received.id, "private_world");
  assert.equal(world.events("2031-05-07", "external-owner").some((item) => item.title === "私人复诊"), true);
  assert.equal(world.events("2031-05-07", "external-other").some((item) => item.title === "私人复诊"), false);
});

test("stale worker leases recover or fail at their attempt limit", async () => {
  const db = await import("@infra/db");
  const jobs = await import("@core/jobs");
  for (const attempts of [1, 3]) {
    db.run(
      `INSERT INTO jobs(kind, payload, run_at, status, attempts, max_attempts, locked_by, locked_at, created_at)
       VALUES('world_tick', '{}', ?, 'running', ?, 3, 'dead-worker', '2020-01-01T00:00:00+08:00', ?)`,
      "2020-01-01T00:00:00+08:00",
      attempts,
      "2020-01-01T00:00:00+08:00",
    );
  }
  const result = jobs.recoverStale(30);
  assert.equal(result.recovered, 1);
  assert.equal(result.failed, 1);
});

test("outbox delivery closes proactive and reminder source records", async () => {
  const db = await import("@infra/db");
  const users = await import("@people/users");
  const delivery = await import("@core/delivery");
  users.getOrCreateUser("delivery-user", "投递测试用户");
  db.run("DELETE FROM outbox");
  db.run(
    `INSERT INTO channel_configs(channel, enabled, mode, capabilities, config, updated_at)
     VALUES('test-webhook', 1, 'webhook', '{"proactive":true}', '{"url":"https://delivery.invalid"}', ?)
     ON CONFLICT(channel) DO UPDATE SET enabled=1, mode='webhook', capabilities=excluded.capabilities, config=excluded.config`,
    "2031-01-01T00:00:00+08:00",
  );
  const proactive = db.run(
    `INSERT INTO proactive_candidates(user_id, topic, reason, available_from, expires_at, status, source_type, created_at)
     VALUES('delivery-user', '测试主动消息', 'test', ?, ?, 'queued', 'test', ?)`,
    "2031-01-01T00:00:00+08:00", "2032-01-01T00:00:00+08:00", "2031-01-01T00:00:00+08:00",
  ).lastId;
  const commitment = db.run(
    `INSERT INTO commitments(user_id, title, status, created_at) VALUES('delivery-user', '测试提醒', 'queued', ?)`,
    "2031-01-01T00:00:00+08:00",
  ).lastId;
  delivery.queue("delivery-user", "test-webhook", "测试主动消息", "proactive", `proactive:${proactive}`);
  delivery.queue("delivery-user", "test-webhook", "测试提醒", "reminder", `commitment:${commitment}`);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("{}", { status: 200, headers: { "x-message-id": "provider-1" } });
  try {
    const result = await delivery.dispatchPending(10);
    assert.equal(result.sent, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(db.one("SELECT status FROM proactive_candidates WHERE id = ?", proactive)?.status, "sent");
  assert.equal(db.one("SELECT status FROM commitments WHERE id = ?", commitment)?.status, "completed");
});

test("terminal outbox failure propagates to its proactive source", async () => {
  const db = await import("@infra/db");
  const delivery = await import("@core/delivery");
  db.run("DELETE FROM outbox");
  const proactive = db.run(
    `INSERT INTO proactive_candidates(user_id, topic, reason, available_from, expires_at, status, source_type, created_at)
     VALUES('delivery-user', '失败主动消息', 'test', ?, ?, 'queued', 'test', ?)`,
    "2031-01-01T00:00:00+08:00", "2032-01-01T00:00:00+08:00", "2031-01-01T00:00:00+08:00",
  ).lastId;
  const outboxId = delivery.queue("delivery-user", "test-webhook", "失败主动消息", "proactive", `proactive:${proactive}`);
  db.run("UPDATE outbox SET attempts = 2 WHERE id = ?", outboxId);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("failed", { status: 503 });
  try {
    const result = await delivery.dispatchPending(10);
    assert.equal(result.failed, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(db.one("SELECT status FROM outbox WHERE id = ?", outboxId)?.status, "failed");
  assert.equal(db.one("SELECT status FROM proactive_candidates WHERE id = ?", proactive)?.status, "failed");
});

test("retention cleanup removes operational history but preserves user data", async () => {
  const db = await import("@infra/db");
  const worker = await import("@worker/loop");
  const beforeMessages = Number(db.one("SELECT count(*) AS n FROM messages")?.n ?? 0);
  const beforeMemories = Number(db.one("SELECT count(*) AS n FROM memories")?.n ?? 0);
  db.run(
    `INSERT INTO jobs(kind, payload, run_at, status, created_at, finished_at)
     VALUES('old-test', '{}', '2020-01-01T00:00:00+08:00', 'completed', '2020-01-01T00:00:00+08:00', '2020-01-01T00:00:00+08:00')`,
  );
  db.run("INSERT INTO audit_log(actor, action, detail, created_at) VALUES('test', 'job_completed', '{}', '2020-01-01T00:00:00+08:00')");
  db.run(
    `INSERT INTO world_events(event_date, title, environment, created_at)
     VALUES('2020-01-01', '旧沙盒事件', 'sandbox', '2020-01-01T00:00:00+08:00')`,
  );
  const result = worker.cleanupRetention();
  assert.ok(result.completedJobs >= 1);
  assert.ok(result.routineAudit >= 1);
  assert.ok(result.sandboxEvents >= 1);
  assert.equal(Number(db.one("SELECT count(*) AS n FROM messages")?.n ?? 0), beforeMessages);
  assert.equal(Number(db.one("SELECT count(*) AS n FROM memories")?.n ?? 0), beforeMemories);
});
});
