import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { databasePath, deepseek, projectRoot } from "@shared/config";
import { businessDate, isoNow, shiftDate } from "@shared/time";

async function main() {
  assert.ok(deepseek().apiKey, "real model key required");
  const source = new DatabaseSync(databasePath(), { readOnly: true });
  const role = source.prepare("SELECT profile FROM character_versions WHERE status = 'published'").get()!;
  const bundle = source.prepare("SELECT * FROM prompt_bundles WHERE status = 'published'").get()!;
  const contents: Record<string, string> = {};
  for (const [key, version] of Object.entries(JSON.parse(String(bundle.module_versions)))) {
    contents[key] = String(source.prepare("SELECT content FROM prompt_modules WHERE module_key = ? AND version = ?").get(key, Number(version))!.content);
  }
  source.close();
  process.env.HARNESS_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "harness-reliability-quality-")), "quality.sqlite3");
  const db = await import("@infra/db");
  const prompting = await import("@prompting");
  const { chat } = await import("@core/conversation");
  const { getOrCreateUser } = await import("@people/users");
  const memory = await import("@memory");
  const reminder = await import("@people/commitments");
  db.ready();
  db.run("UPDATE character_versions SET profile = ? WHERE status = 'published'", role.profile);
  prompting.publishBundle(prompting.createBundle("可靠性隔离回归", contents));
  const turns: Array<{ scenario: string; user: string; reply: string; rewrites: number }> = [];
  const failures: string[] = [];

  async function send(scenario: string, message: string) {
    const result = await chat(`reliability-${scenario}`, "隔离回归", message, "reliability");
    const turn = { scenario, user: message, reply: result.reply, rewrites: result.dialogue_rewrites };
    turns.push(turn); console.log(JSON.stringify(turn));
    assert.equal(result.provider, "deepseek");
    assert.equal(result.semantic_review_status, "checked");
    assert.equal(result.semantic_issues.length + result.capability_issues.length + result.dialogue_issues.length, 0);
    assert.ok(result.hard_checks.contextual_reply && result.hard_checks.executable_commitments && result.hard_checks.no_system_leak);
    return result;
  }
  const scenarios = [
    async () => {
      await send("memory", "我喜欢猫");
      const before = memory.listMemories("reliability-memory").length;
      const question = await send("memory", "我喜欢什么？");
      assert.match(question.reply, /猫/u); assert.deepEqual(question.remembered_ids, []);
      assert.equal(memory.listMemories("reliability-memory").length, before);
      const unknown = await send("memory", "我叫啥来着");
      assert.deepEqual(unknown.memory_candidate_ids, []);
      await send("memory", "以后叫我阿舟");
      assert.match((await send("memory", "你现在怎么叫我")).reply, /阿舟/u);
    },
    async () => {
      for (const text of ["我刚买了相机", "我已经搬家了", "我已经辞职了"]) {
        const result = await send("user-life", text);
        assert.ok(!result.guard_violations.includes("unsupported_world_fact"));
        assert.doesNotMatch(result.reply, /我还没有确认|生活事实|不能说它已经发生/u);
      }
    },
    async () => {
      const id = "reliability-reminder";
      getOrCreateUser(id, "隔离提醒");
      db.run("INSERT INTO channel_configs(channel, enabled, mode, config, updated_at) VALUES('reliability-hook', 1, 'webhook', '{\"url\":\"https://example.test/never-called\"}', ?)", isoNow());
      db.run("INSERT INTO identities(user_id, channel, external_id, created_at) VALUES(?, 'reliability-hook', 'isolated', ?)", id, isoNow());
      const request = await send("reminder", "明天8点提醒我起床");
      assert.ok(request.commitment);
      reminder.confirm(request.commitment.id, `${shiftDate(businessDate(), 1)}T08:00:00+08:00`);
      for (const text of ["提醒设好了吗", "你提醒我了吗", "到点你会主动发我吗"]) {
        const result = await send("reminder", text);
        assert.equal(result.commitment, null);
        assert.equal(result.request_contract.action, "reminder");
      }
      assert.equal(db.one("SELECT count(*) AS n FROM commitments WHERE user_id = ?", id)?.n, 1);
      assert.equal(db.one("SELECT status FROM commitments WHERE id = ?", request.commitment.id)?.status, "pending");
    },
    async () => {
      const id = "reliability-long-memory";
      getOrCreateUser(id, "隔离长记忆");
      memory.remember(id, "用户最喜欢的植物是蓝花楹", "interest", 2);
      for (let index = 0; index < 110; index += 1) memory.remember(id, `其他近期事项${index}`, "fact", 5);
      assert.match((await send("long-memory", "我最喜欢的植物是什么来着")).reply, /蓝花楹/u);
    },
  ];
  for (const result of await Promise.allSettled(scenarios.map((scenario) => scenario()))) {
    if (result.status === "rejected") failures.push(result.reason instanceof Error ? `${result.reason.message} ${JSON.stringify(result.reason.cause ?? "")}` : String(result.reason));
  }
  mkdirSync(path.join(projectRoot(), "data"), { recursive: true });
  writeFileSync(path.join(projectRoot(), "data", "reliability-quality-latest.json"), JSON.stringify({ model: deepseek().model, source_prompt: bundle.id, turns, failures }, null, 2));
  assert.equal(failures.length, 0, failures.join("\n"));
  console.log(JSON.stringify({ ok: true, cases: scenarios.length, turns: turns.length, source_prompt: bundle.id, isolated: true }));
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
