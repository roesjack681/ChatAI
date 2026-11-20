import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";

import { deepseek, projectRoot } from "@shared/config";

async function main() {
  const fixture = await sharp(Buffer.from(`<svg width="720" height="420" xmlns="http://www.w3.org/2000/svg"><rect width="720" height="420" fill="white"/><circle cx="180" cy="140" r="70" fill="#e22222"/><rect x="400" y="70" width="140" height="140" fill="#2255dd"/><text x="80" y="340" font-size="72" font-family="sans-serif" fill="black">VISION-473</text></svg>`)).png().toBuffer();
  if (process.argv.includes("--fixture-only")) {
    const directory = path.join(projectRoot(), "data");
    mkdirSync(directory, { recursive: true });
    const file = path.join(directory, "vision-test-fixture.png");
    writeFileSync(file, fixture);
    console.log(file);
    return;
  }
  const config = deepseek();
  assert.ok(config.apiKey, "DEEPSEEK_API_KEY is required");
  process.env.HARNESS_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "harness-vision-")), "vision.sqlite3");
  const { chat } = await import("@core/conversation");
  const { messageImages } = await import("../packages/core/src/conversation/images");
  const db = await import("@infra/db");
  const image = { name: "test.png", data_url: `data:image/png;base64,${fixture.toString("base64")}` };
  const first = await chat("vision-smoke", "识图测试", "图上写的编号是什么？两个图形分别是什么颜色、什么形状？", "web", [image]);
  console.log(JSON.stringify({ step: "image_and_text", model: config.model, provider: first.provider, reply: first.reply, images_saved: first.images.length }));
  assert.equal(first.provider, "deepseek");
  assert.match(first.reply, /VISION[\s-]*473/i);
  assert.match(first.reply, /红/);
  assert.match(first.reply, /蓝/);
  assert.match(first.reply, /圆/);
  const followup = await chat("vision-smoke", "识图测试", "圆形是什么颜色？直接回答。", "web");
  console.log(JSON.stringify({ step: "followup_without_reupload", provider: followup.provider, reply: followup.reply }));
  assert.equal(followup.provider, "deepseek");
  assert.match(followup.reply, /红/);
  const imageOnly = await chat("vision-only-smoke", "纯图片测试", "", "web", [image]);
  console.log(JSON.stringify({ step: "image_only", provider: imageOnly.provider, reply: imageOnly.reply }));
  assert.equal(imageOnly.provider, "deepseek");
  assert.ok(imageOnly.images.length === 1 && imageOnly.reply.length > 0);
  const stored = db.one("SELECT id FROM messages WHERE user_id = 'vision-smoke' AND role = 'user' ORDER BY id LIMIT 1")!;
  assert.equal(messageImages(Number(stored.id), "vision-smoke").length, 1);
  console.log(JSON.stringify({ ok: true, isolated_database: true }));
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
