import { one, rows, run } from "@infra/db";
import { DomainError } from "@shared/errors";
import { businessDate, isoNow } from "@shared/time";

export function profiles() {
  const people = rows("SELECT * FROM npcs ORDER BY id");
  const events = rows("SELECT * FROM npc_events ORDER BY event_date DESC, id DESC");
  return people.map((npc) => {
    const related = events.filter((event) => event.npc_id === npc.id);
    const score = related.reduce((sum, event) => sum + Number(event.relationship_delta), 0);
    return { ...npc, id: Number(npc.id), name: String(npc.name), profile: String(npc.profile), relationship: String(npc.relationship), updated_at: String(npc.updated_at), events: related.slice(0, 20), relationship_score: score };
  });
}

export function upsertNpc(name: string, profile: string, relationship = "friend"): void {
  if (!name.trim() || name.trim().length > 80) throw new DomainError("人物姓名不能为空且不能超过80字");
  if (!profile.trim() || profile.length > 4000) throw new DomainError("人物档案不能为空且不能超过4000字");
  if (!relationship.trim() || relationship.length > 80) throw new DomainError("人物关系不能为空且不能超过80字");
  run(
    `INSERT INTO npcs(name, profile, relationship, updated_at) VALUES(?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET profile = excluded.profile, relationship = excluded.relationship, updated_at = excluded.updated_at`,
    name.trim(),
    profile.trim(),
    relationship.trim(),
    isoNow(),
  );
}

export function recordEvent(npcId: number, summary: string, relationshipDelta = 0, sourceEventId: number | null = null): number {
  if (!summary.trim()) throw new DomainError("人物事件说明不能为空");
  if (!Number.isFinite(relationshipDelta) || !Number.isInteger(relationshipDelta) || Math.abs(relationshipDelta) > 5) throw new DomainError("relationship delta must be an integer between -5 and 5");
  if (!one("SELECT id FROM npcs WHERE id = ?", npcId)) throw new DomainError("npc not found");
  if (sourceEventId != null && !one("SELECT id FROM world_events WHERE id=? AND share_level='public' AND environment='production' AND status='completed'",sourceEventId)) throw new DomainError("人物关系事件只能引用已完成的公开正式事件");
  return run(
    `INSERT INTO npc_events(npc_id, event_date, summary, relationship_delta, source_event_id, created_at)
     VALUES(?, ?, ?, ?, ?, ?)`,
    npcId,
    businessDate(),
    summary.slice(0, 1000),
    Math.max(-5, Math.min(5, relationshipDelta)),
    sourceEventId,
    isoNow(),
  ).lastId;
}
