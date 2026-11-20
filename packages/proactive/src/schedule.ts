import { ignoreUnique, one, rows, run } from "@infra/db";
import { addHours, addMinutes, hourNow, isoNow } from "@shared/time";
import { queue } from "@core/delivery";
import { canProactivelyContact } from "@core/social";

export function createCandidate(
  userId: string,
  topic: string,
  reason: string,
  sourceType: string,
  sourceId: number | null = null,
  delayMinutes = 30,
  ttlHours = 8,
): number | null {
  if (sourceId != null) {
    const existing = one(
      `SELECT id FROM proactive_candidates
       WHERE user_id = ? AND source_type = ? AND source_id = ? AND status IN ('pending', 'queued', 'sent')`,
      userId,
      sourceType,
      sourceId,
    );
    if (existing) return null;
  }
  const created = ignoreUnique(() =>
    run(
      `INSERT INTO proactive_candidates(user_id, topic, reason, available_from, expires_at, source_type, source_id, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
      userId,
      topic.slice(0, 500),
      reason.slice(0, 500),
      addMinutes(delayMinutes),
      addHours(ttlHours),
      sourceType,
      sourceId,
      isoNow(),
    ),
  );
  return created ? created.lastId : null;
}

export function schedule(limit = 1000) {
  let queued = 0;
  let suppressed = 0;
  let expired = 0;
  const items = rows(
    `SELECT c.*, u.proactive_enabled, u.quiet_start, u.quiet_end, u.unanswered_count
     FROM proactive_candidates c JOIN users u ON u.id = c.user_id
     WHERE c.status = 'pending' AND c.available_from <= ?
     ORDER BY c.priority DESC, c.id LIMIT ?`,
    isoNow(),
    limit,
  );
  for (const item of items) {
    if (String(item.expires_at) < isoNow()) {
      run("UPDATE proactive_candidates SET status = 'expired' WHERE id = ?", item.id);
      expired += 1;
      continue;
    }
    const decision = canProactivelyContact({
      proactive_enabled: Number(item.proactive_enabled),
      quiet_start: String(item.quiet_start),
      quiet_end: String(item.quiet_end),
      unanswered_count: Number(item.unanswered_count),
    }, hourNow());
    if (!decision.allowed) {
      run("UPDATE proactive_candidates SET status = 'suppressed', reason = reason || ? WHERE id = ?", `；${decision.reason}`, item.id);
      suppressed += 1;
      continue;
    }
    const identity = one("SELECT channel FROM identities WHERE user_id = ? ORDER BY id LIMIT 1", item.user_id);
    const channel = identity ? String(identity.channel) : "web";
    const channelConfig = one("SELECT * FROM channel_configs WHERE channel = ? AND enabled = 1", channel);
    const capabilities = channelConfig ? JSON.parse(String(channelConfig.capabilities || "{}")) as { proactive?: boolean } : {};
    if (!capabilities.proactive || channelConfig?.mode === "sync") {
      run(
        "UPDATE proactive_candidates SET status = 'suppressed', reason = reason || ? WHERE id = ?",
        `；渠道 ${channel} 不支持主动托管投递`,
        item.id,
      );
      suppressed += 1;
      continue;
    }
    queue(String(item.user_id), channel, String(item.topic), "proactive", `proactive:${item.id}`);
    run("UPDATE proactive_candidates SET status = 'queued' WHERE id = ?", item.id);
    queued += 1;
  }
  return { queued, suppressed, expired };
}

export function seedFromWorld() {
  let created = 0;
  const events = rows(
    "SELECT * FROM world_events WHERE environment = 'production' AND status = 'completed' AND share_level = 'public' AND event_date >= date('now', '-1 day')",
  );
  const users = rows("SELECT id FROM users WHERE proactive_enabled = 1");
  for (const event of events) {
    for (const user of users) {
      const topic = `刚才发生了一件小事：${event.title}。${event.details}`;
      if (createCandidate(String(user.id), topic, "已完成且可分享的生活事件", "world_event", Number(event.id)) != null) created += 1;
    }
  }
  return { created };
}
