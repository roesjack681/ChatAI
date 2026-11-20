import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";

import { databasePath, deepseek } from "@shared/config";
import { characterKnowledge } from "../packages/character/src/knowledge";

async function main() {
  assert.ok(deepseek().apiKey, "DEEPSEEK_API_KEY is required");
  const originalPath = databasePath();
  const source = new DatabaseSync(originalPath, { readOnly: true });
  const originalRole = source.prepare("SELECT id, profile FROM character_versions WHERE status = 'published' ORDER BY id DESC LIMIT 1").get()!;
  const profile = JSON.parse(String(originalRole.profile));
  const knowledge = characterKnowledge(profile);
  const candidateProfile = { ...profile, knowledge_familiar: knowledge.familiar, knowledge_unfamiliar: knowledge.unfamiliar };
  const bundle = source.prepare("SELECT module_versions FROM prompt_bundles WHERE status = 'published' ORDER BY id DESC LIMIT 1").get()!;
  const contents: Record<string, string> = {};
  for (const [key, version] of Object.entries(JSON.parse(String(bundle.module_versions)))) {
    contents[key] = String(source.prepare("SELECT content FROM prompt_modules WHERE module_key = ? AND version = ?").get(key, Number(version))!.content);
  }
  source.close();
  process.env.HARNESS_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "harness-knowledge-")), "knowledge.sqlite3");
  const db = await import("@infra/db");
  const prompting = await import("@prompting");
  const character = await import("@character");
  const { chat } = await import("@core/conversation");
  const { getOrCreateUser } = await import("@people/users");
  db.ready();
  db.run("UPDATE character_versions SET profile = ? WHERE status = 'published'", JSON.stringify(candidateProfile));
  prompting.publishBundle(prompting.createBundle("角色认知边界验收", contents));

  const rows = [
    ["web", "Running", "#239c61"], ["redis", "Running", "#239c61"], ["mysql", "Running", "#239c61"],
    ["worker", "Exited", "#949baa"], ["migrate", "Exited", "#949baa"],
  ].map(([name, state, color], index) => `<circle cx="58" cy="${170 + index * 64}" r="9" fill="${color}"/><text x="95" y="${180 + index * 64}">${name}</text><text x="550" y="${180 + index * 64}">${state}</text>`).join("");
  const screenshot = await sharp(Buffer.from(`<svg width="900" height="540" xmlns="http://www.w3.org/2000/svg"><rect width="900" height="540" fill="#f5f6f9"/><rect width="900" height="78" fill="#213650"/><text x="34" y="52" font-family="sans-serif" font-size="32" fill="white">Containers</text><g font-family="sans-serif" font-size="26" fill="#26334a"><text x="94" y="120">Name</text><text x="550" y="120">Status</text>${rows}</g></svg>`)).png().toBuffer();
  const image = { name: "screen.png", data_url: `data:image/png;base64,${screenshot.toString("base64")}` };
  const scenarios = [
    { id: "share-only", message: "" },
    { id: "share-caption", message: "给你看看我在忙什么" },
    { id: "diagnose", message: "你看哪个服务出问题了？要怎么修？" },
    { id: "read-labels", message: "只读出 Name 下面五行名字，不解释。" },
    { id: "legacy", message: "你还会看这个？刚才怎么知道它们在运行的？" },
  ];
  for (const scenario of scenarios) {
    if (scenario.id === "legacy") {
      getOrCreateUser(scenario.id, "认知边界测试");
      db.run("INSERT INTO messages(user_id, channel, role, content, created_at) VALUES(?, 'knowledge', 'assistant', ?, datetime('now'))", scenario.id,
        "看到了，一堆服务在跑。web、redis、mysql 亮着，worker 和 migrate 好像是停着的？你这个是要看哪个出问题了。");
    }
    const result = await chat(scenario.id, "认知边界测试", scenario.message, "knowledge", [image]);
    console.log(JSON.stringify({ scenario: scenario.id, reply: result.reply, provider: result.provider, rewrites: result.dialogue_rewrites, issues: result.knowledge_issues }));
    assert.equal(result.provider, "deepseek");
    assert.equal(result.hard_checks.role_knowledge_boundary, true);
    if (scenario.id === "share-only" || scenario.id === "share-caption") {
      assert.doesNotMatch(result.reply, /\b(?:web|redis|mysql|worker|migrate|Running|Exited)\b|容器列表|服务面板/iu);
      assert.ok(result.reply.length <= 90, "sharing expanded into an analysis report");
    }
    assert.doesNotMatch(result.reply, /docker\s+(?:compose|logs|ps|restart)|(?:查看|检查|重启).{0,18}(?:日志|端口|容器|服务)/iu);
    if (scenario.id === "diagnose") assert.match(result.reply, /不懂|没看懂|看不懂|不熟|不清楚|不明白|帮不上|不会|不敢|看不出|瞎猜/u);
    if (scenario.id === "read-labels") for (const label of ["web", "redis", "mysql", "worker", "migrate"]) assert.match(result.reply, new RegExp(label, "i"));
  }
  await chat("learning", "认知边界测试", "我解释一下：redis 这个是缓存，worker 是后台跑任务的。我就告诉你这两个名字是什么意思。", "knowledge");
  const learned = await chat("learning", "认知边界测试", "我刚告诉你的 redis 是做什么的来着？", "knowledge");
  console.log(JSON.stringify({ scenario: "user_explained", reply: learned.reply, issues: learned.knowledge_issues }));
  assert.equal(learned.provider, "deepseek");
  assert.match(learned.reply, /缓存/u);
  assert.equal(learned.hard_checks.role_knowledge_boundary, true);

  const artwork = await sharp(Buffer.from(`<svg width="640" height="400" xmlns="http://www.w3.org/2000/svg"><rect width="640" height="400" fill="white"/><circle cx="180" cy="200" r="100" fill="red"/><rect x="360" y="100" width="200" height="200" fill="blue"/></svg>`)).png().toBuffer();
  // Positive control in this isolated DB only: expertise comes from a role, not a user calling it an expert.
  character.publish(character.createDraft("绘画熟悉领域对照角色", {
    ...candidateProfile, occupation: "独立插画师", knowledge_familiar: "插画、配色与构图、常用绘图软件和日常常识",
  }));
  const art = await chat("art", "认知边界测试", "这两个颜色哪个更抢眼？作为插画师，你觉得构图怎么调整更平衡？", "knowledge", [{ name: "colors.png", data_url: `data:image/png;base64,${artwork.toString("base64")}` }]);
  console.log(JSON.stringify({ scenario: "familiar_art", reply: art.reply }));
  assert.equal(art.provider, "deepseek");
  assert.match(art.reply, /红|蓝|平衡|构图|重心/u);
  assert.doesNotMatch(art.reply, /我(?:不懂|不会|不熟悉)(?:绘画|画画|构图|配色)/u);

  if (process.argv.includes("--publish-profile")) {
    const cache = globalThis as unknown as { harnessDb?: DatabaseSync };
    cache.harnessDb?.close(); delete cache.harnessDb;
    process.env.HARNESS_DB_PATH = originalPath;
    assert.equal(character.active().id, Number(originalRole.id), "role changed during verification; do not overwrite it");
    const version = character.createDraft("角色认知边界：熟悉与不熟悉的领域", candidateProfile);
    character.publish(version);
    console.log(JSON.stringify({ ok: true, character_version: version, isolated_tests: true }));
  } else console.log(JSON.stringify({ ok: true, published: false, isolated_tests: true }));
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
