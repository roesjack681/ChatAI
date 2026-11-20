import { audit, ignoreUnique, one, run } from "@infra/db";
import { DomainError } from "@shared/errors";
import { isoNow } from "@shared/time";
import { queueCandidate } from "@memory";
import { addEvent } from "@world/daily-life";

export function receive(input: {
  source: string;
  externalId: string;
  userId: string;
  eventType: string;
  payload: unknown;
}): { duplicate: true } | { id: number; status: "received" } {
  const created = ignoreUnique(() =>
    run(
      `INSERT INTO external_events(source, external_id, user_id, event_type, payload, trust_level, created_at)
       VALUES(?, ?, ?, ?, ?, 'authorized_app', ?)`,
      input.source,
      input.externalId,
      input.userId,
      input.eventType,
      JSON.stringify(input.payload ?? {}),
      isoNow(),
    ),
  );
  if (!created) return { duplicate: true };
  return { id: created.lastId, status: "received" };
}

export function review(eventId: number, decision: string, summary = "") {
  const item = one("SELECT * FROM external_events WHERE id = ? AND status = 'received'", eventId);
  if (!item) throw new DomainError("external event not found or already reviewed");
  if (!["private_memory", "private_world", "reject"].includes(decision)) throw new DomainError("invalid review decision");
  const payload = JSON.parse(String(item.payload || "{}")) as Record<string, unknown>;
  const result: Record<string, unknown> = { event_id: eventId, decision };
  if (decision === "private_memory") {
    const text = summary.trim() || `外部事件 ${item.event_type}：${JSON.stringify(payload)}`;
    result.candidate_id = queueCandidate(String(item.user_id), text, "external_event", 0.78, null, `授权外部应用 ${item.source}，经管理员审核`);
  } else if (decision === "private_world") {
    const title = summary.trim() || String(payload.title || item.event_type);
    result.world_event_id = addEvent({
      title,
      details: JSON.stringify(payload),
      day: payload.date == null ? null : String(payload.date),
      startTime: payload.start_time == null ? null : String(payload.start_time),
      endTime: payload.end_time == null ? null : String(payload.end_time),
      status: "planned",
      shareLevel: "private",
      userId: String(item.user_id),
      source: `external:${item.source}`,
    });
  }
  run("UPDATE external_events SET status = ? WHERE id = ?", decision === "reject" ? "rejected" : "approved", eventId);
  audit("external_event_reviewed", result);
  return result;
}
