import { audit, one, rows, run, transaction } from "@infra/db";
import { DomainError } from "@shared/errors";
import { isoNow } from "@shared/time";

const SCOPES = new Set(["global", "character", "location", "organization", "npc"]);

export interface WorldFact {
  id: number;
  subject: string;
  predicate: string;
  object: string;
  scope: string;
  status: string;
  source: string;
  confidence: number;
  conflict_with: number | null;
  superseded_by: number | null;
  created_at: string;
}

function map(row: Record<string, unknown>): WorldFact {
  return {
    id: Number(row.id), subject: String(row.subject), predicate: String(row.predicate), object: String(row.object),
    scope: String(row.scope), status: String(row.status), source: String(row.source), confidence: Number(row.confidence),
    conflict_with: row.conflict_with == null ? null : Number(row.conflict_with),
    superseded_by: row.superseded_by == null ? null : Number(row.superseded_by), created_at: String(row.created_at),
  };
}

export function activeFacts(limit = 100): WorldFact[] {
  return rows("SELECT * FROM world_facts WHERE status = 'active' ORDER BY scope, subject, predicate LIMIT ?", limit).map(map);
}

export function catalog(status = ""): WorldFact[] {
  return rows("SELECT * FROM world_facts WHERE (? = '' OR status = ?) ORDER BY id DESC LIMIT 500", status, status).map(map);
}

export function proposeFact(input: { subject: string; predicate: string; object: string; scope?: string; source?: string; confidence?: number }) {
  const subject = input.subject.trim().slice(0, 120);
  const predicate = input.predicate.trim().slice(0, 80);
  const object = input.object.trim().slice(0, 1000);
  const scope = (input.scope || "global").trim();
  if (!subject || !predicate || !object) throw new DomainError("世界事实的主体、属性和值不能为空");
  if (!SCOPES.has(scope)) throw new DomainError("invalid world fact scope");
  const existing = one(
    "SELECT * FROM world_facts WHERE scope = ? AND subject = ? AND predicate = ? AND status = 'active'",
    scope, subject, predicate,
  );
  if (existing && String(existing.object) === object) return { id: Number(existing.id), status: "active", duplicate: true, conflict_with: null };
  const created = run(
    `INSERT INTO world_facts(subject, predicate, object, scope, status, source, confidence, conflict_with, created_at)
     VALUES(?, ?, ?, ?, 'proposed', ?, ?, ?, ?)`,
    subject, predicate, object, scope, (input.source || "admin").slice(0, 80),
    Math.max(0, Math.min(1, Number(input.confidence ?? 1))), existing?.id ?? null, isoNow(),
  );
  audit("world_fact_proposed", { id: created.lastId, subject, predicate, conflict_with: existing?.id ?? null });
  return { id: created.lastId, status: "proposed", duplicate: false, conflict_with: existing ? Number(existing.id) : null };
}

export function reviewFact(id: number, accept: boolean) {
  const candidate = one("SELECT * FROM world_facts WHERE id = ? AND status = 'proposed'", id);
  if (!candidate) throw new DomainError("world fact proposal not found or already reviewed");
  transaction(() => {
    if (accept) {
      const current = one(
        "SELECT id FROM world_facts WHERE scope = ? AND subject = ? AND predicate = ? AND status = 'active'",
        candidate.scope, candidate.subject, candidate.predicate,
      );
      if (current) run("UPDATE world_facts SET status = 'superseded', superseded_by = ?, reviewed_at = ? WHERE id = ?", id, isoNow(), current.id);
      run("UPDATE world_facts SET status = 'active', reviewed_at = ? WHERE id = ?", isoNow(), id);
    } else {
      run("UPDATE world_facts SET status = 'rejected', reviewed_at = ? WHERE id = ?", isoNow(), id);
    }
  });
  audit("world_fact_reviewed", { id, accepted: accept });
  return map(one("SELECT * FROM world_facts WHERE id = ?", id)!);
}
