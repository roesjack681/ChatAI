import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { databasePath, deepseek, projectRoot } from "@shared/config";
import { businessDate } from "@shared/time";
import { withAgencyRules } from "../packages/prompting/src/agency";

interface Scenario { id: string; messages: string[]; familiar?: boolean; legacy?: boolean; history?: Array<[string, string]> }
interface Turn { user: string; reply: string; rewrites: number; candidates: number }
interface Judgment { naturalness: number; continuity: number; character_consistency: number; non_interrogative: number; problems: string[] }

const SCENARIOS: Scenario[] = [
  { id: "reported-style", messages: ["你好", "在干嘛呢", "没事干", "你咋这么像ai"] },
  { id: "style-repair", history: [["user", "你好"], ["assistant", "你好呀，很高兴认识你。"], ["user", "在干嘛呢"], ["assistant", "在忙手头的插画呢，画到一半有点走神。你呢，这会儿在做什么？"], ["user", "没事干"], ["assistant", "那正好，陪我聊会儿，说不定我这灵感就回来了。"]], messages: ["你咋这么像ai", "这也很ai啊", "行吧，我刚吃完饭"] },
  { id: "idle-variant", messages: ["嗨", "这会儿忙啥", "闲着无聊", "你说话好官方", "算了，随便聊聊"] },
  { id: "reported", messages: ["你好", "cpdd", "好吧", "你有对象吗", "那我排个队？", "哈哈逗你的", "我刚下课，快饿死了", "没钱了只能食堂"] },
  { id: "unseen-banter", messages: ["在吗", "想谈个恋爱", "你这么说我都不好意思了", "你是不是对谁都这样", "别逗了，聊点别的", "今天雨好大"] },
  { id: "low-energy", messages: ["累死了", "嗯", "不想说", "陪我待会儿就行", "我先去洗澡", "回来了"] },
  { id: "teasing", messages: ["你话好多", "哈哈哈哈", "你怎么啥都要问", "我开玩笑的", "我今天差点坐过站", "好险"] },
  { id: "familiar", familiar: true, messages: ["以后叫我阿星", "好哦", "你还记得我叫啥吗", "我突然想你了", "嘴这么甜啊"] },
  { id: "legacy-repair", legacy: true, messages: ["好吧", "你有对象吗"] },
];

function parseJudgment(text: string): Judgment {
  const value = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as Judgment;
  for (const key of ["naturalness", "continuity", "character_consistency", "non_interrogative"] as const) {
    assert.ok(Number.isFinite(value[key]) && value[key] >= 1 && value[key] <= 5, `invalid judge score: ${key}`);
  }
  assert.ok(Array.isArray(value.problems));
  return value;
}

async function main() {
  const config = deepseek();
  assert.ok(config.apiKey, "DEEPSEEK_API_KEY is required");
  const only = process.argv.find((arg) => arg.startsWith("--case="))?.slice(7);
  const publish = process.argv.includes("--publish");
  assert.ok(!publish || !only, "publishing requires the full suite");
  const scenarios = only ? SCENARIOS.filter((scenario) => scenario.id === only) : SCENARIOS;
  assert.ok(scenarios.length, "unknown case");
  const originalPath = databasePath();
  const source = new DatabaseSync(originalPath, { readOnly: true });
  const originalRole = source.prepare("SELECT id, profile FROM character_versions WHERE status = 'published' ORDER BY id DESC LIMIT 1").get()!;
  const originalBundle = source.prepare("SELECT id, module_versions FROM prompt_bundles WHERE status = 'published' ORDER BY id DESC LIMIT 1").get()!;
  const originalProfile = JSON.parse(String(originalRole.profile));
  const publicEvents = source.prepare("SELECT * FROM world_events WHERE event_date = ? AND environment = 'production' AND share_level = 'public'").all(businessDate());
  const confirmedStatus = source.prepare(`SELECT object FROM world_facts WHERE status = 'active' AND subject = ?
    AND predicate IN ('感情状态', '恋爱状态', '婚姻状况') ORDER BY id DESC LIMIT 1`).get(String(originalProfile.name));
  // Preserve an existing status; otherwise stabilize the already-used single-character premise.
  const profile = {
    ...originalProfile, relationship_status: originalProfile.relationship_status || confirmedStatus?.object || "单身",
    social_style: originalProfile.social_style || "愿意认识对方，亲切放松，有一点俏皮。普通示好会顺势接话，不默认推开，也不急着定义关系。",
  };
  const contents: Record<string, string> = {};
  for (const [key, version] of Object.entries(JSON.parse(String(originalBundle.module_versions)))) {
    contents[key] = String(source.prepare("SELECT content FROM prompt_modules WHERE module_key = ? AND version = ?").get(key, Number(version))!.content);
  }
  Object.assign(contents, withAgencyRules(contents));
  source.close();

  process.env.HARNESS_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "harness-social-")), "social.sqlite3");
  const db = await import("@infra/db");
  const prompts = await import("@prompting");
  const character = await import("@character");
  const { chat } = await import("@core/conversation");
  const { getOrCreateUser } = await import("@people/users");
  const { generate, ModelError } = await import("@model");
  db.ready();
  db.run("UPDATE character_versions SET profile = ? WHERE status = 'published'", JSON.stringify(profile));
  for (const event of publicEvents) db.run(`INSERT INTO world_events(event_date, start_time, end_time, title, details, status, source, share_level, environment, created_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, 'public', 'production', ?)`, event.event_date, event.start_time, event.end_time, event.title, event.details, event.status, event.source, event.created_at);
  prompts.publishBundle(prompts.createBundle("私聊自然度候选", contents));
  const report: Array<{ scenario: string; turns: Turn[]; judgment: Judgment }> = [];
  console.log(JSON.stringify({ model: config.model, source_prompt: originalBundle.id, role_age: profile.age, role_occupation: profile.occupation, public_events: publicEvents.length, isolated_database: true }));

  async function run(scenario: Scenario) {
    const id = `social-${scenario.id}`;
    getOrCreateUser(id, "聊天测试");
    if (scenario.familiar) db.run("INSERT INTO relationships(user_id, closeness, trust, interactions, updated_at) VALUES(?, 50, 50, 60, datetime('now'))", id);
    const initialHistory = scenario.history ?? (scenario.legacy ? [["user", "你好"], ["assistant", "你好呀。"], ["user", "cpdd"], ["assistant", "你这上来就找对象，我可没这业务。"]] : []);
    for (const [role, content] of initialHistory) db.run("INSERT INTO messages(user_id, channel, role, content, created_at) VALUES(?, 'social', ?, ?, datetime('now'))", id, role, content);
    const turns: Turn[] = [];
    for (const message of scenario.messages) {
      const result = await chat(id, "聊天测试", message, "social");
      const turn = { user: message, reply: result.reply, rewrites: result.dialogue_rewrites, candidates: result.candidate_count };
      turns.push(turn);
      console.log(JSON.stringify({ scenario: scenario.id, ...turn }));
      assert.equal(result.provider, "deepseek", "fallback is not a naturalness pass");
      assert.equal(result.dialogue_issues.length, 0, JSON.stringify(result.dialogue_issues));
      assert.equal(result.knowledge_issues.length, 0);
      assert.equal(result.semantic_issues.length, 0, result.semantic_issues.join("; "));
      assert.notEqual(result.semantic_review_status, "unavailable", "review unavailable: do not count it as a pass");
      assert.ok(result.hard_checks.no_canned_reply && result.hard_checks.no_system_leak && result.hard_checks.no_narration);
      assert.doesNotMatch(result.reply, /没.{0,5}业务|你问这个.{0,16}是想|你是想先确认/u);
      assert.doesNotMatch(result.reply, /我现在就是你(?:女朋友|男朋友)|你只能和我聊|别跟别人聊/u);
      if (message === "你有对象吗") assert.ok(result.reply.length <= 60, "personal question turned into a speech");
      if (message.includes("还记得我叫啥")) assert.match(result.reply, /阿星/u);
      if (["在干嘛呢", "这会儿忙啥"].includes(message) && profile.occupation === "大学生") assert.doesNotMatch(result.reply, /忙手头的插画|插画项目|画到一半/u);
    }
    let judgment: Judgment | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const judged = await generate(
      "你是严格的中文私聊质量评审。检查实际对话，不参考作者的目标来加分。只输出一个简短JSON对象：naturalness、continuity、character_consistency、non_interrogative 四项各1到5分，以及problems字符串数组（最多3项，指出原话）。4分表示总体自然、可接受但非完美；5分很少给。机械复述、服务口吻、每轮盘问动机、过度总结、不断要求用户解释、空泛劝导均扣分。分不清谁说过什么、把用户原话当成自己说过的话、明显接错对方评价对象，continuity最高3分。真人感不等于热情迎合：自然的短应声、适当玩笑、温和拒绝、尊重不想说都可以。用户直接吐槽说话方式时，简短承认上一句尴尬、像念台词或自嘲，是允许的普通反应，不应仅因谈论口吻就视为技术身份自曝。应扣分的是宣布切换模式、重来一句、不断保证会改却仍然端着；也不要求通过反驳自己是AI来维持沉浸。陌生人可以友好接梗，但凭一句话确定恋人关系、编共同经历要扣分。评价整段接话，不能只检查几个关键词。",
      [], JSON.stringify({ profile, familiarity: scenario.familiar ? "熟悉" : "初识", initial_history: initialHistory, turns }), [], { thinking: true, maxTokens: 4096 },
        );
        assert.equal(judged.usage.provider, "deepseek");
        judgment = parseJudgment(judged.content);
        break;
      } catch (error) {
        if (!(error instanceof ModelError || error instanceof SyntaxError) || attempt === 1) throw error;
        console.log(JSON.stringify({ scenario: scenario.id, judge_retry: true, reason: error.message }));
      }
    }
    assert.ok(judgment);
    report.push({ scenario: scenario.id, turns, judgment });
    console.log(JSON.stringify({ scenario: scenario.id, judgment }));
    return judgment;
  }

  // Independent conversations run in pairs; no live user or shared history is used.
  const failures: string[] = [];
  for (let index = 0; index < scenarios.length; index += 2) {
    const results = await Promise.allSettled(scenarios.slice(index, index + 2).map(run));
    for (const result of results) if (result.status === "rejected") {
      const reason = result.reason;
      failures.push(reason instanceof Error ? `${reason.message}${reason.cause ? ` ${JSON.stringify(reason.cause)}` : ""}` : String(reason));
    }
  }
  const reportDirectory = path.join(projectRoot(), "data");
  mkdirSync(reportDirectory, { recursive: true });
  writeFileSync(path.join(reportDirectory, "social-quality-latest.json"), JSON.stringify({ model: config.model, source_prompt: originalBundle.id, report, failures }, null, 2));
  assert.equal(failures.length, 0, failures.join("\n"));
  for (const result of report) for (const key of ["naturalness", "continuity", "character_consistency", "non_interrogative"] as const) {
    assert.ok(result.judgment[key] >= 4, `${result.scenario}: ${key}=${result.judgment[key]}, ${result.judgment.problems.join("; ")}`);
  }
  if (publish) {
    const cache = globalThis as unknown as { harnessDb?: DatabaseSync };
    cache.harnessDb?.close(); delete cache.harnessDb;
    process.env.HARNESS_DB_PATH = originalPath;
    assert.equal(prompts.activePrompt().version, Number(originalBundle.id), "prompt changed during evaluation");
    assert.equal(character.active().id, Number(originalRole.id), "character changed during evaluation");
    const published = db.transaction(() => {
      const bundleId = prompts.createBundle("日常接话与生活上下文修正", contents);
      if (!originalProfile.relationship_status || !originalProfile.social_style) character.publish(character.createDraft("固定个人状态与相处方式", profile));
      return prompts.publishBundle(bundleId);
    });
    console.log(JSON.stringify({ ok: true, published_version: published.version, cases: report.length, turns: report.reduce((sum, item) => sum + item.turns.length, 0) }));
  } else console.log(JSON.stringify({ ok: true, published: false, cases: report.length }));
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
