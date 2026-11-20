import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

test("an existing database is migrated with world event end times", async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "harness-migration-")), "legacy.sqlite3");
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE world_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_date TEXT NOT NULL,
      start_time TEXT,
      title TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'planned',
      source TEXT NOT NULL DEFAULT 'planner',
      share_level TEXT NOT NULL DEFAULT 'public',
      user_id TEXT,
      environment TEXT NOT NULL DEFAULT 'production',
      created_at TEXT NOT NULL
    );
  `);
  legacy.exec(`CREATE TABLE outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL REFERENCES users(id), channel TEXT NOT NULL,
    content TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'reply', idempotency_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending', provider_message_id TEXT, attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT, created_at TEXT NOT NULL, sent_at TEXT
  )`);
  const { SCHEMA } = await import("../infra/db/src/schema");
  legacy.exec(SCHEMA);
  legacy.exec(`
    INSERT INTO users(id, display_name, created_at) VALUES
      ('legacy-web', '旧聊天', '2026-11-01'), ('legacy-qq', '渠道用户', '2026-11-01'), ('legacy-empty', '未聊天身份', '2026-11-01');
    INSERT INTO messages(user_id, channel, role, content, created_at) VALUES
      ('legacy-web', 'web', 'user', '旧消息', '2026-11-01'),
      ('legacy-web', 'web', 'assistant', '旧回复', '2026-11-02'),
      ('legacy-qq', 'qq', 'user', '其他渠道', '2026-11-01');
    INSERT INTO outbox(user_id, channel, content, idempotency_key, created_at)
      VALUES('legacy-web', 'web', '迁移前的通知', 'legacy-delivery', '2026-11-01');
  `);
  legacy.close();
  process.env.HARNESS_DB_PATH = file;
  const db = await import("@infra/db");
  db.ready();
  const columns = db.rows("PRAGMA table_info(world_events)");
  assert.equal(columns.some((column) => column.name === "end_time"), true);
  assert.equal(Number(db.one("SELECT max(version) AS n FROM schema_migrations")?.n), 11);
  assert.ok(db.rows("PRAGMA table_info(outbox)").some((column) => column.name === "lock_token"));
  assert.ok(db.rows("PRAGMA table_info(outbox)").some((column) => column.name === "locked_at"));
  assert.equal(db.one("SELECT content FROM outbox WHERE idempotency_key = 'legacy-delivery'")?.content, "迁移前的通知");
  assert.equal(db.one("SELECT lock_token FROM outbox WHERE idempotency_key = 'legacy-delivery'")?.lock_token, null);
  assert.ok(db.one("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'worker_heartbeats'"));
  assert.ok(db.one("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'world_facts'"));
  const memoryColumns = db.rows("PRAGMA table_info(memories)").map((column) => String(column.name));
  assert.equal(memoryColumns.includes("memory_key"), true);
  assert.equal(memoryColumns.includes("access_count"), true);
  assert.ok(db.one("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'relationship_events'"));
  assert.ok(db.one("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chat_conversations'"));
  assert.ok(db.one("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'message_images'"));
  assert.deepEqual(db.rows("SELECT user_id, updated_at FROM chat_conversations").map((item) => ({ ...item })), [{ user_id: "legacy-web", updated_at: "2026-11-02" }]);
  db.run("DELETE FROM chat_conversations WHERE user_id = 'legacy-web'");
  const cache = globalThis as unknown as { harnessDb?: DatabaseSync };
  cache.harnessDb?.close();
  delete cache.harnessDb;
  db.ready();
  assert.equal(db.rows("SELECT * FROM chat_conversations").length, 0, "migration must not resurrect deleted entries on restart");
});
