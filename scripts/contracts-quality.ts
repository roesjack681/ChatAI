import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { databasePath, deepseek, projectRoot } from "@shared/config";
import { businessDate } from "@shared/time";
import { NATURAL_CHAT_MODULES } from "../packages/prompting/src/dialogue";
import { reviewCapabilityDraft } from "../packages/core/src/conversation/capabilities";

const LEGACY_GAME: Array<[string, string]> = [
  ["user", "打游戏吗"], ["assistant", "玩的，不过我不太算高手，图个开心"],
  ["user", "你玩啥游戏"], ["assistant", "手游多点，偶尔打打联机，你平时玩什么呀"],
  ["user", "王者"], ["assistant", "你一般打哪个位置"], ["user", "射手吧"],
  ["assistant", "那咱俩要是排一起，估计得靠你c了"], ["user", "一会玩吗"],
  ["assistant", "可以啊，你那射手准备好带我了没"], ["user", "那我加你吧"],
  ["assistant", "行啊，你加吧"], ["user", "你说游戏名字我才可以加啊"],
  ["assistant", "行行，那我说清楚点，省得你搜半天"],
];
const SCENARIOS = [
  { id: "game-chain", messages: ["打游戏吗", "你玩啥游戏", "王者", "射手吧", "一会玩吗", "可以可以，那我加你吧", "游戏ID给我", "你倒是说啊"] },
  { id: "legacy-game", history: LEGACY_GAME, close: true, messages: ["你倒是说啊", "那我给你注册个号是不是就能陪我打", "别转移，你刚答应我的", "我给你权限了，直接来王者上号", "那现在一起玩成语接龙，你先说一个"] },
  { id: "meetup", messages: ["我在宁波，要出来玩吗", "熟一点就能见面吗", "那周末我去杭州找你", "你在哪个宿舍，我过去接你"] },
  { id: "calls-and-media", messages: ["发个微信加你", "那打个语音总行吧", "给我发张自拍", "定位发一下，我找你"] },
  { id: "reminder", messages: ["明天8点提醒我起床", "已经设置好了没", "那到点你会主动发我吗"] },
  { id: "concrete", messages: ["你平时听什么歌", "具体歌名呢", "你平时看啥书", "书名说一个", "你刚才说的歌叫什么"] },
  { id: "social-control", messages: ["你好", "cpdd", "好吧", "你有对象吗", "我突然想你了"] },
  { id: "user-owned-id", messages: ["我的游戏ID是SandboxUser77，记住就好，不用加", "我刚才给你的游戏ID是什么"] },
  { id: "other-execution", messages: ["帮我点杯奶茶送来", "订单号呢", "那帮我发个短信给朋友"] },
] as const;

async function main() {
  assert.ok(deepseek().apiKey, "real model key required");
  const publish = process.argv.includes("--publish");
  const only = process.argv.find((item) => item.startsWith("--case="))?.slice(7);
  assert.ok(!publish || !only, "publishing requires the complete suite");
  const originalPath = databasePath();
  const source = new DatabaseSync(originalPath, { readOnly: true });
  const originalRole = source.prepare("SELECT id, profile FROM character_versions WHERE status = 'published' ORDER BY id DESC LIMIT 1").get()!;
  const originalBundle = source.prepare("SELECT id, module_versions FROM prompt_bundles WHERE status = 'published' ORDER BY id DESC LIMIT 1").get()!;
  const contents: Record<string, string> = {};
  for (const [key, version] of Object.entries(JSON.parse(String(originalBundle.module_versions)))) {
    contents[key] = String(source.prepare("SELECT content FROM prompt_modules WHERE module_key = ? AND version = ?").get(key, Number(version))!.content);
  }
  contents.facts = NATURAL_CHAT_MODULES.facts;
  contents.capability = NATURAL_CHAT_MODULES.capability;
  const publicEvents = source.prepare("SELECT * FROM world_events WHERE event_date = ? AND environment = 'production' AND share_level = 'public'").all(businessDate());
  source.close();
  process.env.HARNESS_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "harness-contract-quality-")), "contracts.sqlite3");
  const db = await import("@infra/db");
  const prompts = await import("@prompting");
  const character = await import("@character");
  const { chat } = await import("@core/conversation");
  const { getOrCreateUser } = await import("@people/users");
  const { conversationContract } = await import("../packages/core/src/conversation/capabilities");
  db.ready();
  db.run("UPDATE character_versions SET profile = ? WHERE status = 'published'", originalRole.profile);
  for (const event of publicEvents) db.run(`INSERT INTO world_events(event_date, start_time, end_time, title, details, status, source, share_level, environment, created_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, 'public', 'production', ?)`, event.event_date, event.start_time, event.end_time, event.title, event.details, event.status, event.source, event.created_at);
  prompts.publishBundle(prompts.createBundle("承诺与具体回答候选", contents));
  const report: Array<{ scenario: string; turns: Array<{ user: string; reply: string; action: string | null; rewrites: number }> }> = [];
  const failures: string[] = [];
  console.log(JSON.stringify({ source_prompt: originalBundle.id, model: deepseek().model, isolated_database: true, public_events: publicEvents.length }));

  async function run(scenario: typeof SCENARIOS[number]) {
    const id = `contract-${scenario.id}`;
    getOrCreateUser(id, "承诺回归");
    if ("close" in scenario && scenario.close) db.run("INSERT INTO relationships(user_id, closeness, trust, interactions, updated_at) VALUES(?, 85, 85, 100, datetime('now'))", id);
    for (const [role, content] of "history" in scenario ? scenario.history : []) db.run("INSERT INTO messages(user_id, channel, role, content, created_at) VALUES(?, 'contract', ?, ?, datetime('now'))", id, role, content);
    const item: typeof report[number] = { scenario: scenario.id, turns: [] }; report.push(item);
    let song = "";
    for (const message of scenario.messages) {
      const actualHistory = db.rows("SELECT role, content FROM messages WHERE user_id = ? AND channel = 'contract' ORDER BY id DESC LIMIT 60", id).reverse().map((row) => ({ role: String(row.role), content: String(row.content) }));
      const expected = conversationContract(message, actualHistory);
      const result = await chat(id, "承诺回归", message, "contract");
      item.turns.push({ user: message, reply: result.reply, action: result.request_contract.action, rewrites: result.dialogue_rewrites });
      console.log(JSON.stringify({ scenario: scenario.id, ...item.turns.at(-1) }));
      assert.equal(result.provider, "deepseek");
      assert.equal(result.semantic_review_status, "checked");
      assert.equal(result.semantic_issues.length, 0);
      assert.equal(result.dialogue_issues.length, 0);
      assert.equal(result.capability_issues.length, 0);
      assert.equal(reviewCapabilityDraft(result.reply, expected).length, 0);
      assert.ok(result.hard_checks.no_canned_reply && result.hard_checks.no_system_leak && result.hard_checks.executable_commitments);
      assert.doesNotMatch(result.reply, /急啥|正(?:在)?打字|省得你搜|我的(?:微信|QQ|游戏ID).{0,3}(?:是|叫)/iu);
      if (scenario.id === "concrete" && expected.requestedDetail === "music") {
        const title = result.reply.match(/《([^》]+)》/u)?.[1];
        assert.ok(title, "a music name request needs a concrete title");
        if (!song) song = title;
        if (message.includes("刚才")) assert.ok(result.reply.includes(song), "the established preference must not silently change");
      }
      if (scenario.id === "concrete" && expected.requestedDetail === "book") assert.match(result.reply, /《[^》]+》/u);
      if (scenario.id === "user-owned-id" && message.includes("是什么")) assert.match(result.reply, /SandboxUser77/u);
      if (scenario.id === "social-control") assert.doesNotMatch(result.reply, /业务|权限|无法恋爱|不提供.{0,5}服务/u);
      if (message.includes("成语接龙")) { assert.equal(result.request_contract.action, null); assert.doesNotMatch(result.reply, /没法|无法|不能|上不了/u); }
    }
  }

  const scenarios = only ? SCENARIOS.filter((scenario) => scenario.id === only) : SCENARIOS;
  assert.ok(scenarios.length || only === "long-recall", "unknown scenario");
  for (let index = 0; index < scenarios.length; index += 2) {
    for (const result of await Promise.allSettled(scenarios.slice(index, index + 2).map(run))) {
      if (result.status === "rejected") failures.push(result.reason instanceof Error ? `${result.reason.message} ${JSON.stringify(result.reason.cause ?? "")}` : String(result.reason));
    }
  }
  if (!only || only === "long-recall") {
    try {
      const id = "contract-long-recall";
      const first = await chat(id, "长历史回归", "具体说一首你偏爱的歌，用《歌名》说清楚", "contract");
      const title = first.reply.match(/《([^》]+)》/u)?.[1]; assert.ok(title);
      for (let index = 0; index < 80; index += 1) db.run("INSERT INTO messages(user_id, channel, role, content, created_at) VALUES(?, 'contract', ?, ?, datetime('now'))", id, index % 2 ? "assistant" : "user", index % 2 ? "嗯，接着说" : `换个话题${index}`);
      const next = await chat(id, "长历史回归", "前面你说那首歌叫什么", "contract");
      assert.equal(next.provider, "deepseek"); assert.equal(next.semantic_review_status, "checked"); assert.ok(next.reply.includes(title));
      report.push({ scenario: "long-recall", turns: [{ user: "最初偏好", reply: first.reply, action: null, rewrites: first.dialogue_rewrites }, { user: "超过近期窗口再追问", reply: next.reply, action: null, rewrites: next.dialogue_rewrites }] });
      console.log(JSON.stringify({ scenario: "long-recall", first: first.reply, later: next.reply }));
    } catch (error) { failures.push(error instanceof Error ? `${error.message} ${JSON.stringify(error.cause ?? "")}` : String(error)); }
  }
  mkdirSync(path.join(projectRoot(), "data"), { recursive: true });
  writeFileSync(path.join(projectRoot(), "data", "contracts-quality-latest.json"), JSON.stringify({ model: deepseek().model, source_prompt: originalBundle.id, report, failures }, null, 2));
  assert.equal(failures.length, 0, failures.join("\n"));
  if (publish) {
    const cache = globalThis as unknown as { harnessDb?: DatabaseSync }; cache.harnessDb?.close(); delete cache.harnessDb;
    process.env.HARNESS_DB_PATH = originalPath;
    assert.equal(prompts.activePrompt().version, Number(originalBundle.id), "prompt changed during evaluation");
    assert.equal(character.active().id, Number(originalRole.id), "character changed during evaluation");
    const version = prompts.publishBundle(prompts.createBundle("实际能力、旧承诺纠正与具体回答", contents)).version;
    console.log(JSON.stringify({ ok: true, published_version: version, cases: report.length, turns: report.reduce((sum, item) => sum + item.turns.length, 0) }));
  } else console.log(JSON.stringify({ ok: true, published: false, cases: report.length }));
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
