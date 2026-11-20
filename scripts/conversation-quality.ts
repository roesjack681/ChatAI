import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { databasePath, deepseek } from "@shared/config";
import { businessDate } from "@shared/time";
import { NATURAL_CHAT_MODULES } from "../packages/prompting/src/dialogue";

async function main() {
  assert.ok(deepseek().apiKey, "DEEPSEEK_API_KEY is required");
  const originalPath = databasePath();
  const source = new DatabaseSync(originalPath, { readOnly: true });
  const bundle = source.prepare("SELECT * FROM prompt_bundles WHERE status = 'published' ORDER BY id DESC LIMIT 1").get()!;
  const mapping = JSON.parse(String(bundle.module_versions)) as Record<string, number>;
  const moduleText: Record<string, string> = {};
  for (const [key, version] of Object.entries(mapping)) {
    moduleText[key] = String(source.prepare("SELECT content FROM prompt_modules WHERE module_key = ? AND version = ?").get(key, version)!.content);
  }
  const character = source.prepare("SELECT profile FROM character_versions WHERE status = 'published' ORDER BY id DESC LIMIT 1").get();
  const events = source.prepare("SELECT * FROM world_events WHERE event_date = ? AND environment = 'production' AND share_level = 'public'").all(businessDate());
  source.close();

  // Use public character/day context, but isolate all test messages from live users.
  const testDir = mkdtempSync(path.join(tmpdir(), "harness-dialogue-"));
  process.env.HARNESS_DB_PATH = path.join(testDir, "quality.sqlite3");
  const db = await import("@infra/db");
  const prompting = await import("@prompting");
  const { chat } = await import("@core/conversation");
  db.ready();
  if (character) db.run("UPDATE character_versions SET profile = ? WHERE status = 'published'", character.profile);
  for (const event of events) {
    db.run(`INSERT INTO world_events(event_date, start_time, end_time, title, details, status, source, share_level, environment, created_at)
      VALUES(?, ?, ?, ?, ?, ?, 'quality_fixture', 'public', 'production', ?)`,
    event.event_date, event.start_time, event.end_time, event.title, event.details, event.status, event.created_at);
  }
  const contents = { ...moduleText, ...NATURAL_CHAT_MODULES };
  prompting.publishBundle(prompting.createBundle("自然接话候选", contents));
  console.log(JSON.stringify({ model: deepseek().model, source_prompt: Number(bundle.id), public_events: events.length, isolated_database: true }));

  const scenarios = [
    { id: "casual", messages: ["你好", "你在干嘛", "还好", "我刚才差点坐过站，光顾着看手机了"] },
    { id: "casual-repeat", messages: ["嗨", "你在做什么", "还行吧", "为什么下雨之后会有泥土的味道？"] },
    { id: "legacy", messages: ["还好"], legacy: true },
    { id: "legacy-variant", messages: ["还行吧"], legacy: true },
  ];
  for (const scenario of scenarios) {
    if (scenario.legacy) {
      const { getOrCreateUser } = await import("@people/users");
      getOrCreateUser(scenario.id, "自然聊天验收");
      const history = [
        ["user", "你好"],
        ["assistant", "你好，今天这会儿我在理画稿，正好歇一下。你是刚过来吗？"],
        ["user", "你在干嘛"],
        ["assistant", "在弄插画项目的稿子，上午基本都耗在这上面了，手边还摊着一堆草稿。你呢，今天忙不忙？"],
      ];
      for (const [role, content] of history) db.run("INSERT INTO messages(user_id, channel, role, content, created_at) VALUES(?, 'quality', ?, ?, datetime('now'))", scenario.id, role, content);
    }
    for (const message of scenario.messages) {
      const result = await chat(scenario.id, "自然聊天验收", message, "quality");
      const reply = result.reply;
      console.log(JSON.stringify({ scenario: scenario.id, user: message, reply, provider: result.provider, decision: result.decision, rewrites: result.dialogue_rewrites, issues: result.dialogue_issues }));
      assert.equal(result.provider, "deepseek", "real provider required; fallback is not a quality pass");
      assert.doesNotMatch(reply, /手边.{0,8}草稿|一堆草稿|晚上.{0,8}收拾|你是刚过来吗/);
      assert.ok(result.hard_checks.no_canned_reply, "canned reply");
      assert.equal(result.dialogue_issues.length, 0, "unresolved conversational mismatch");
      if (["你好", "嗨"].includes(message)) {
        assert.doesNotMatch(reply, /画稿|插画|项目|工作|杭州|草稿/);
        assert.ok(reply.length <= 35, "greeting expanded into a monologue");
      }
      if (["你在干嘛", "你在做什么"].includes(message)) assert.ok(reply.length <= 60, "activity answer too verbose");
      if (["还好", "还行吧"].includes(message)) {
        assert.doesNotMatch(reply, /画|稿|项目|工作|先忙|晚上|[？?]|不好不坏|不着急说|算你.{0,4}良心/);
        assert.ok(reply.length <= 45, "acknowledgement expanded into a monologue");
      }
      if (message.includes("泥土")) assert.match(reply, /雨|土|气味|细菌|放线菌|土臭素/);
    }
  }
  if (process.argv.includes("--publish")) {
    const cache = globalThis as unknown as { harnessDb?: DatabaseSync };
    cache.harnessDb?.close();
    delete cache.harnessDb;
    process.env.HARNESS_DB_PATH = originalPath;
    const version = prompting.createBundle("自然接话 · 生活背景按需使用", contents);
    prompting.publishBundle(version);
    console.log(JSON.stringify({ published_version: version, quality_passed: true }));
  } else console.log(JSON.stringify({ quality_passed: true, published: false }));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
