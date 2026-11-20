import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.HARNESS_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "harness-delivery-")), "delivery.sqlite3");
process.env.DEEPSEEK_API_KEY = "";

async function setup() {
  const db = await import("@infra/db");
  const { getOrCreateUser } = await import("@people/users");
  getOrCreateUser("delivery-concurrency", "投递回归");
  db.run("DELETE FROM outbox");
  db.run("INSERT OR IGNORE INTO channel_configs(channel, enabled, mode, config, updated_at) VALUES('lease-test', 1, 'webhook', '{\"url\":\"https://example.test/hook\"}', datetime('now'))");
  return { db, delivery: await import("@core/delivery") };
}

test("two concurrent dispatchers send one pending item only once", async (t) => {
  const { db, delivery } = await setup();
  const id = delivery.queue("delivery-concurrency", "lease-test", "单次投递", "reply", "concurrency-test");
  let calls = 0;
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => { finish = resolve; });
  t.mock.method(globalThis, "fetch", async () => { calls += 1; await waiting; return new Response("ok"); });
  const first = delivery.dispatchPending(10);
  const second = delivery.dispatchPending(10);
  finish();
  const results = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(results.reduce((sum, result) => sum + result.sent, 0), 1);
  assert.equal(db.one("SELECT status FROM outbox WHERE id = ?", id)?.status, "sent");
  assert.equal(db.one("SELECT attempts FROM outbox WHERE id = ?", id)?.attempts, 1);
});

test("outbox and reminder source roll back together if completion storage fails", async (t) => {
  const { db, delivery } = await setup();
  const commitment = db.run("INSERT INTO commitments(user_id, title, status, created_at) VALUES('delivery-concurrency', '原子完成', 'queued', datetime('now'))").lastId;
  const id = delivery.queue("delivery-concurrency", "lease-test", "提醒", "reminder", `commitment:${commitment}`);
  db.run("CREATE TRIGGER fail_delivery_completion BEFORE UPDATE OF status ON commitments WHEN NEW.id = " + commitment + " AND NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'test delivery storage failure'); END");
  t.after(() => db.run("DROP TRIGGER IF EXISTS fail_delivery_completion"));
  t.mock.method(globalThis, "fetch", async () => new Response("ok"));
  await delivery.dispatchPending(10);
  assert.equal(db.one("SELECT status FROM outbox WHERE id = ?", id)?.status, "pending");
  assert.equal(db.one("SELECT sent_at FROM outbox WHERE id = ?", id)?.sent_at, null);
  assert.equal(db.one("SELECT attempts FROM outbox WHERE id = ?", id)?.attempts, 1);
  assert.equal(db.one("SELECT status FROM commitments WHERE id = ?", commitment)?.status, "queued");
  db.run("DROP TRIGGER fail_delivery_completion");
  await delivery.dispatchPending(10);
  assert.equal(db.one("SELECT status FROM outbox WHERE id = ?", id)?.status, "sent");
  assert.equal(db.one("SELECT status FROM commitments WHERE id = ?", commitment)?.status, "completed");
});

test("expired delivery leases recover and stale results cannot overwrite a new attempt", async (t) => {
  const { db, delivery } = await setup();
  const id = delivery.queue("delivery-concurrency", "lease-test", "租约恢复", "reply", "lease-recovery");
  let finish!: () => void;
  const waiting = new Promise<void>((resolve) => { finish = resolve; });
  t.mock.method(globalThis, "fetch", async () => { await waiting; return new Response("old", { headers: { "x-message-id": "old-result" } }); });
  const oldAttempt = delivery.dispatchPending();
  db.run("UPDATE outbox SET locked_at = '2020-01-01T00:00:00+08:00' WHERE id = ?", id);
  assert.deepEqual(delivery.recoverStaleDeliveries(), { recovered: 1, failed: 0 });
  t.mock.method(globalThis, "fetch", async () => new Response("new", { headers: { "x-message-id": "new-result" } }));
  assert.equal((await delivery.dispatchPending()).sent, 1);
  finish();
  assert.equal((await oldAttempt).sent, 0);
  assert.equal(db.one("SELECT provider_message_id FROM outbox WHERE id = ?", id)?.provider_message_id, "new-result");
});

test("an expired final attempt marks its reminder as failed instead of leaving it queued", async () => {
  const { db, delivery } = await setup();
  const commitment = db.run("INSERT INTO commitments(user_id, title, status, created_at) VALUES('delivery-concurrency', '终止恢复', 'queued', datetime('now'))").lastId;
  const id = delivery.queue("delivery-concurrency", "lease-test", "提醒", "reminder", `commitment:${commitment}`);
  db.run("UPDATE outbox SET status = 'sending', attempts = 3, lock_token = 'dead-worker', locked_at = '2020-01-01T00:00:00+08:00' WHERE id = ?", id);
  assert.deepEqual(delivery.recoverStaleDeliveries(), { recovered: 0, failed: 1 });
  assert.equal(db.one("SELECT status FROM commitments WHERE id = ?", commitment)?.status, "failed");
  assert.equal(db.one("SELECT lock_token FROM outbox WHERE id = ?", id)?.lock_token, null);
});
