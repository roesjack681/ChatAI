import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { databasePath } from "@shared/config";
import { isUniqueViolation } from "@shared/errors";
import { isoNow } from "@shared/time";
import { SCHEMA } from "./schema";
import { seed } from "./seed";

export type Row = Record<string, any>;

type Statement = {
  all: (...args: unknown[]) => Row[];
  get: (...args: unknown[]) => Row | undefined;
  run: (...args: unknown[]) => { changes: number | bigint; lastInsertRowid: number | bigint };
};

const globalDb = globalThis as unknown as { harnessDb?: DatabaseSync; harnessDepth?: number };

function bind(args: unknown[]): unknown[] {
  return args.map((value) => (value === undefined ? null : value));
}

function migrate(db: DatabaseSync): void {
  const worldColumns = db.prepare("PRAGMA table_info(world_events)").all() as Array<{ name: string }>;
  if (!worldColumns.some((column) => column.name === "end_time")) {
    db.exec("ALTER TABLE world_events ADD COLUMN end_time TEXT");
  }
  const memoryColumns = db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
  if (!memoryColumns.some((column) => column.name === "memory_key")) db.exec("ALTER TABLE memories ADD COLUMN memory_key TEXT");
  if (!memoryColumns.some((column) => column.name === "access_count")) db.exec("ALTER TABLE memories ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0");
  if (!memoryColumns.some((column) => column.name === "last_accessed_at")) db.exec("ALTER TABLE memories ADD COLUMN last_accessed_at TEXT");
  if (!memoryColumns.some((column) => column.name === "superseded_by")) db.exec("ALTER TABLE memories ADD COLUMN superseded_by INTEGER REFERENCES memories(id)");
  const outboxColumns = db.prepare("PRAGMA table_info(outbox)").all() as Array<{ name: string }>;
  if (!outboxColumns.some((column) => column.name === "lock_token")) db.exec("ALTER TABLE outbox ADD COLUMN lock_token TEXT");
  if (!outboxColumns.some((column) => column.name === "locked_at")) db.exec("ALTER TABLE outbox ADD COLUMN locked_at TEXT");
  const goalColumns = db.prepare("PRAGMA table_info(goals)").all() as Array<{ name: string }>;
  for (const [column, definition] of [["stage", "TEXT NOT NULL DEFAULT 'preparing'"], ["obstacle", "TEXT NOT NULL DEFAULT ''"], ["next_action", "TEXT NOT NULL DEFAULT ''"], ["milestones", "TEXT NOT NULL DEFAULT '[]'"]]) {
    if (!goalColumns.some((item) => item.name === column)) db.exec(`ALTER TABLE goals ADD COLUMN ${column} ${definition}`);
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_memory_active_key ON memories(user_id, memory_key) WHERE status = 'active' AND memory_key IS NOT NULL");
  db.prepare("INSERT OR IGNORE INTO schema_migrations(version, name, applied_at) VALUES(2, 'world_event_end_time', ?)").run(isoNow());
  db.prepare("INSERT OR IGNORE INTO schema_migrations(version, name, applied_at) VALUES(3, 'worker_heartbeats', ?)").run(isoNow());
  db.prepare("INSERT OR IGNORE INTO schema_migrations(version, name, applied_at) VALUES(4, 'world_facts', ?)").run(isoNow());
  db.prepare("INSERT OR IGNORE INTO schema_migrations(version, name, applied_at) VALUES(5, 'memory_lifecycle', ?)").run(isoNow());
  db.prepare("INSERT OR IGNORE INTO schema_migrations(version, name, applied_at) VALUES(6, 'relationship_events', ?)").run(isoNow());
  db.prepare("INSERT OR IGNORE INTO schema_migrations(version, name, applied_at) VALUES(8, 'message_images', ?)").run(isoNow());
  db.prepare("INSERT OR IGNORE INTO schema_migrations(version, name, applied_at) VALUES(9, 'outbox_delivery_lease', ?)").run(isoNow());
  db.prepare("INSERT OR IGNORE INTO schema_migrations(version, name, applied_at) VALUES(10, 'companion_data_pack', ?)").run(isoNow());
  db.prepare("INSERT OR IGNORE INTO schema_migrations(version, name, applied_at) VALUES(11, 'user_portraits', ?)").run(isoNow());
  db.exec("BEGIN IMMEDIATE");
  try {
    const added = db.prepare("INSERT OR IGNORE INTO schema_migrations(version, name, applied_at) VALUES(7, 'chat_conversations', ?)").run(isoNow());
    if (Number(added.changes)) {
      db.exec(`INSERT OR IGNORE INTO chat_conversations(user_id, created_at, updated_at)
        SELECT user_id, min(created_at), max(created_at) FROM messages WHERE channel = 'web' GROUP BY user_id`);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function database(): DatabaseSync {
  if (globalDb.harnessDb) return globalDb.harnessDb;
  const file = databasePath();
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA);
  migrate(db);
  seed(db, isoNow());
  globalDb.harnessDb = db;
  globalDb.harnessDepth = 0;
  return db;
}

function statement(sql: string): Statement {
  return database().prepare(sql) as unknown as Statement;
}

function depth(): number {
  return globalDb.harnessDepth ?? 0;
}

export function rows(sql: string, ...args: unknown[]): Row[] {
  return statement(sql).all(...bind(args));
}

export function one(sql: string, ...args: unknown[]): Row | undefined {
  return statement(sql).get(...bind(args));
}

export function run(sql: string, ...args: unknown[]): { lastId: number; changes: number } {
  const own = depth() === 0;
  if (own) database().exec("BEGIN IMMEDIATE");
  try {
    const result = statement(sql).run(...bind(args));
    if (own) database().exec("COMMIT");
    return { lastId: Number(result.lastInsertRowid), changes: Number(result.changes) };
  } catch (error) {
    if (own) database().exec("ROLLBACK");
    throw error;
  }
}

export function transaction<T>(work: () => T): T {
  const db = database();
  const outer = depth() === 0;
  if (outer) db.exec("BEGIN IMMEDIATE");
  globalDb.harnessDepth = depth() + 1;
  try {
    const result = work();
    globalDb.harnessDepth = depth() - 1;
    if (outer) db.exec("COMMIT");
    return result;
  } catch (error) {
    globalDb.harnessDepth = depth() - 1;
    if (outer) db.exec("ROLLBACK");
    throw error;
  }
}

export function audit(action: string, detail: unknown, actor = "admin"): void {
  run(
    "INSERT INTO audit_log(actor, action, detail, created_at) VALUES(?, ?, ?, ?)",
    actor,
    action,
    JSON.stringify(detail),
    isoNow(),
  );
}

export function ignoreUnique<T>(work: () => T): T | undefined {
  try {
    return work();
  } catch (error) {
    if (isUniqueViolation(error)) return undefined;
    throw error;
  }
}

export function ready(): void {
  database();
}
