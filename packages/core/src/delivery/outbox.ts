import { createHash, randomUUID } from "node:crypto";

import { ignoreUnique, one, rows, run, transaction } from "@infra/db";
import { addSeconds, isoNow } from "@shared/time";

export function queue(userId: string, channel: string, content: string, kind = "reply", idempotencyKey?: string | null): number {
  const key = idempotencyKey || createHash("sha256").update(`${userId}:${channel}:${kind}:${content}`).digest("hex");
  const created = ignoreUnique(() =>
    run(
      "INSERT INTO outbox(user_id, channel, content, kind, idempotency_key, created_at) VALUES(?, ?, ?, ?, ?, ?)",
      userId,
      channel,
      content.slice(0, 4000),
      kind,
      key,
      isoNow(),
    ),
  );
  if (created) return created.lastId;
  return Number(one("SELECT id FROM outbox WHERE idempotency_key = ?", key)?.id ?? 0);
}

export async function dispatch(item: Record<string, unknown>): Promise<{ provider_message_id: string }> {
  const config = one("SELECT * FROM channel_configs WHERE channel = ?", item.channel);
  if (!config || !Number(config.enabled)) throw new Error(`channel ${item.channel} is disabled or unconfigured`);
  const settings = JSON.parse(String(config.config || "{}")) as { url?: string; token?: string };
  if (config.mode === "sync") throw new Error("sync-return channels are not dispatched by outbox");
  if (config.mode !== "webhook") throw new Error(`unsupported delivery mode: ${config.mode}`);
  if (!settings.url) throw new Error("webhook url is missing");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(settings.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.token ?? ""}` },
      body: JSON.stringify({ user_id: item.user_id, content: item.content, idempotency_key: item.idempotency_key }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`webhook status ${response.status}`);
    return { provider_message_id: response.headers.get("x-message-id") || `http-${response.status}` };
  } finally {
    clearTimeout(timer);
  }
}

function closeSource(item: Record<string, unknown>, delivered: boolean) {
  if (item.kind === "proactive") {
    const candidateId = String(item.idempotency_key).match(/^proactive:(\d+)$/)?.[1];
    if (candidateId) run("UPDATE proactive_candidates SET status = ?, reason = reason || ? WHERE id = ? AND status = 'queued'",
      delivered ? "sent" : "failed", delivered ? "" : "；投递达到最大重试次数", Number(candidateId));
    if (delivered) run("UPDATE users SET last_proactive_at = ?, unanswered_count = unanswered_count + 1 WHERE id = ?", isoNow(), item.user_id);
  }
  if (item.kind === "reminder") {
    const commitmentId = String(item.idempotency_key).match(/^commitment:(\d+)$/)?.[1];
    if (commitmentId) run("UPDATE commitments SET status = ?, completed_at = ? WHERE id = ? AND status = 'queued'",
      delivered ? "completed" : "failed", delivered ? isoNow() : null, Number(commitmentId));
  }
}

/** HTTP requests time out after 10 seconds; a 60-second lease survives normal delivery. */
export function recoverStaleDeliveries() {
  return transaction(() => {
    let recovered = 0;
    let failed = 0;
    const stale = rows("SELECT * FROM outbox WHERE status = 'sending' AND (locked_at IS NULL OR julianday(locked_at) < julianday(?))", addSeconds(-60));
    for (const item of stale) {
      const terminal = Number(item.attempts) >= 3;
      run("UPDATE outbox SET status = ?, lock_token = NULL, locked_at = NULL, last_error = ? WHERE id = ?",
        terminal ? "failed" : "pending", "delivery lease expired; previous delivery result unknown", item.id);
      if (terminal) { closeSource(item, false); failed += 1; }
      else recovered += 1;
    }
    return { recovered, failed };
  });
}

export async function dispatchPending(limit = 50) {
  recoverStaleDeliveries();
  let sent = 0;
  let failed = 0;
  const pending = rows("SELECT * FROM outbox WHERE status = 'pending' ORDER BY id LIMIT ?", limit);
  for (const item of pending) {
    const token = randomUUID();
    const claimed = run("UPDATE outbox SET status = 'sending', lock_token = ?, locked_at = ?, attempts = attempts + 1 WHERE id = ? AND status = 'pending'", token, isoNow(), item.id);
    if (!claimed.changes) continue;
    try {
      const result = await dispatch(item);
      const completed = transaction(() => {
        const updated = run("UPDATE outbox SET status = 'sent', provider_message_id = ?, sent_at = ?, last_error = NULL, lock_token = NULL, locked_at = NULL WHERE id = ? AND status = 'sending' AND lock_token = ?",
          result.provider_message_id, isoNow(), item.id, token);
        if (!updated.changes) return false;
        closeSource(item, true);
        return true;
      });
      if (completed) sent += 1;
    } catch (error) {
      const updated = transaction(() => {
        const current = one("SELECT attempts FROM outbox WHERE id = ? AND status = 'sending' AND lock_token = ?", item.id, token);
        if (!current) return false;
        const terminal = Number(current.attempts) >= 3;
        run("UPDATE outbox SET status = ?, last_error = ?, lock_token = NULL, locked_at = NULL WHERE id = ? AND lock_token = ?",
          terminal ? "failed" : "pending", String(error instanceof Error ? error.message : error).slice(0, 1000), item.id, token);
        if (terminal) closeSource(item, false);
        return true;
      });
      if (updated) failed += 1;
    }
  }
  return { sent, failed };
}
