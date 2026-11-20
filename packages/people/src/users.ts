import { one, rows, run } from "@infra/db";
import { isoNow } from "@shared/time";

export interface User {
  id: string;
  display_name: string;
  created_at: string;
  proactive_enabled: number;
  quiet_start: string;
  quiet_end: string;
  last_proactive_at: string | null;
  unanswered_count: number;
}

function mapUser(row: Record<string, unknown>): User {
  return {
    id: String(row.id),
    display_name: String(row.display_name),
    created_at: String(row.created_at),
    proactive_enabled: Number(row.proactive_enabled),
    quiet_start: String(row.quiet_start),
    quiet_end: String(row.quiet_end),
    last_proactive_at: row.last_proactive_at == null ? null : String(row.last_proactive_at),
    unanswered_count: Number(row.unanswered_count),
  };
}

export function getOrCreateUser(userId: string | null | undefined, displayName = "朋友"): User {
  const id = (userId || "web-default").trim().slice(0, 100) || "web-default";
  const existing = one("SELECT * FROM users WHERE id = ?", id);
  if (!existing) {
    run("INSERT INTO users(id, display_name, created_at) VALUES(?, ?, ?)", id, displayName.slice(0, 80), isoNow());
  } else if (displayName && displayName !== "朋友") {
    run("UPDATE users SET display_name = ? WHERE id = ?", displayName.slice(0, 80), id);
  }
  return mapUser(one("SELECT * FROM users WHERE id = ?", id)!);
}

export function requireUser(userId: string): User | undefined {
  const row = one("SELECT * FROM users WHERE id = ?", userId);
  return row ? mapUser(row) : undefined;
}

export function listUsers(): User[] {
  return rows("SELECT * FROM users ORDER BY created_at DESC").map(mapUser);
}
