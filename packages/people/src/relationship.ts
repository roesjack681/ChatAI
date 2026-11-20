import { one, rows, run, transaction } from "@infra/db";
import { isoNow } from "@shared/time";
import { targetedInsult } from "@shared/social-signals";

export interface RelationshipState {
  user_id: string;
  closeness: number;
  trust: number;
  interactions: number;
  updated_at: string;
  stage: "new" | "acquaintance" | "familiar" | "close";
}

export function getRelationship(userId: string): RelationshipState {
  run("INSERT OR IGNORE INTO relationships(user_id, updated_at) VALUES(?, ?)", userId, isoNow());
  const value = one("SELECT user_id, closeness, trust, interactions, updated_at FROM relationships WHERE user_id = ?", userId)!;
  const closeness = Number(value.closeness);
  const trust = Number(value.trust);
  const interactions = Number(value.interactions);
  const stage: RelationshipState["stage"] = closeness >= 70 && trust >= 70 ? "close"
    : closeness >= 40 && trust >= 40 ? "familiar"
    : closeness >= 15 || interactions >= 6 ? "acquaintance" : "new";
  return { user_id: String(value.user_id), closeness, trust, interactions: Number(value.interactions), updated_at: String(value.updated_at), stage };
}

function signal(message: string) {
  let closeness = message.trim().length >= 10 ? 1 : 0;
  let trust = 0;
  const reasons: string[] = [];
  const clauses = message.split(/[，,。！？!?；;\n]/u);
  const positive = clauses.some((clause) => /谢谢|辛苦了|喜欢和你聊|想你|很懂我/u.test(clause)
    && !/(?:不|没|并非|不是).{0,4}(?:谢谢|喜欢和你聊|想你|懂我)|(?:他|她|朋友|室友).{0,4}(?:说|觉得)/u.test(clause));
  if (positive) { closeness += 2; trust += 1; reasons.push("positive_connection"); }
  if (/(其实|只告诉你|跟你说个秘密|我有点难过|我很害怕)/.test(message)) { trust += 2; reasons.push("personal_disclosure"); }
  const negative = !/开玩笑|逗你|才怪|哈哈/u.test(message) && clauses.some((clause) => /闭嘴|讨厌你|别烦我|你.{0,4}烦死了/u.test(clause)
    && !/(?:不|没|并非|不是).{0,4}(?:讨厌你|叫你闭嘴|说你烦)|(?:他|她|朋友|室友).{0,4}(?:说|觉得)/u.test(clause));
  if (negative || targetedInsult(message)) { closeness -= 2; trust -= 1; reasons.push("negative_interaction"); }
  if (/(不要问|别再问|不想聊这个|别提这个)/.test(message)) reasons.push("boundary_stated");
  if (!reasons.length) reasons.push("ordinary_interaction");
  return { closeness: Math.max(-3, Math.min(3, closeness)), trust: Math.max(-2, Math.min(2, trust)), reason: reasons.join(",") };
}

export function recordInteraction(userId: string, message = "", sourceMessageId: number | null = null) {
  const change = signal(message);
  transaction(() => {
    run(
      `INSERT INTO relationships(user_id, closeness, trust, interactions, updated_at)
       VALUES(?, ?, ?, 1, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         closeness = max(0, min(100, closeness + ?)),
         trust = max(0, min(100, trust + ?)),
         interactions = interactions + 1,
         updated_at = excluded.updated_at`,
      userId, Math.max(0, 5 + change.closeness), Math.max(0, 10 + change.trust), isoNow(), change.closeness, change.trust,
    );
    run(
      "INSERT INTO relationship_events(user_id, closeness_delta, trust_delta, reason, source_message_id, created_at) VALUES(?, ?, ?, ?, ?, ?)",
      userId, change.closeness, change.trust, change.reason, sourceMessageId, isoNow(),
    );
  });
  return getRelationship(userId);
}

export function relationshipEvents(userId: string, limit = 50) {
  return rows("SELECT * FROM relationship_events WHERE user_id = ? ORDER BY id DESC LIMIT ?", userId, limit);
}
