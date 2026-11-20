import { audit, one, rows, run, transaction } from "@infra/db";
import { DomainError } from "@shared/errors";
import { isoNow } from "@shared/time";
import { characterKnowledge } from "./knowledge";
import type { LifeExperience, RoleRelation } from "./fields";

const REQUIRED = ["name", "age", "occupation", "city", "personality", "voice", "boundaries"] as const;
const LOCKED = new Set(["name", "age", "occupation", "city", "personality", "boundaries"]);

export interface CharacterProfile {
  name: string;
  age: number | string;
  occupation: string;
  city: string;
  personality: string;
  voice: string;
  boundaries: string;
  relationship_status?: string;
  social_style?: string;
  knowledge_familiar?: string;
  knowledge_unfamiliar?: string;
  life_experiences?: LifeExperience[];
  relationship_network?: RoleRelation[];
  growth: Record<string, string>;
  version: number;
}

function parse(row: Record<string, unknown>) {
  return {
    id: Number(row.id),
    name: String(row.name ?? ""),
    profile: JSON.parse(String(row.profile)) as Record<string, unknown>,
    growth: JSON.parse(String(row.growth || "{}")) as Record<string, string>,
    status: String(row.status ?? "draft"),
    author: String(row.author ?? ""),
    created_at: String(row.created_at ?? ""),
    published_at: row.published_at == null ? null : String(row.published_at),
  };
}

function assertProfile(profile: Record<string, unknown>) {
  const missing = REQUIRED.filter((key) => !(key in profile));
  if (missing.length) throw new DomainError(`角色档案缺少字段: ${missing.join(", ")}`);
  if (!String(profile.name ?? "").trim()) throw new DomainError("角色姓名不能为空");
  for (const field of ["occupation","city","personality","voice","boundaries"]) if (typeof profile[field] !== "string" || !String(profile[field]).trim() || String(profile[field]).length > 5000) throw new DomainError(`角色字段无效: ${field}`);
  const age = Number(profile.age);
  if (!Number.isInteger(age) || age < 0 || age > 120 || String(profile.age).trim() === "") throw new DomainError("角色年龄必须是0到120之间的整数");
  if (profile.life_experiences !== undefined) {
    if (!Array.isArray(profile.life_experiences) || profile.life_experiences.length > 40) throw new DomainError("成长经历必须为最多40条的列表");
    const ids = new Set<string>();
    for (const item of profile.life_experiences) {
      if (!item || typeof item !== "object" || ["id","period","title","event","impact"].some((key)=>typeof item[key]!=="string" || !item[key].trim() || item[key].length>3000)) throw new DomainError("成长经历字段不完整");
      if (ids.has(item.id)) throw new DomainError("成长经历编号重复"); ids.add(item.id);
      if (![item.age_start,item.age_end].every(Number.isInteger) || item.age_start<0 || item.age_end<item.age_start || item.age_end>age) throw new DomainError("成长经历年龄范围无效");
      for (const key of ["people","keywords"]) if (!Array.isArray(item[key]) || item[key].length>20 || item[key].some((text:unknown)=>typeof text!=="string" || !text.trim() || text.length>80)) throw new DomainError("经历人物与关键词格式无效");
    }
  }
  if (profile.relationship_network !== undefined) {
    if (!Array.isArray(profile.relationship_network) || profile.relationship_network.length>40) throw new DomainError("关系网必须为最多40条的列表");
    const edges = new Set<string>();
    for (const item of profile.relationship_network) {
      if (!item || typeof item!=="object" || ["from","to","relation","closeness","interaction","boundary"].some((key)=>typeof item[key]!=="string" || !item[key].trim() || item[key].length>2000)) throw new DomainError("关系网字段不完整");
      const key = [item.from,item.to].sort().join("\u0000");
      if (item.from===item.to || edges.has(key)) throw new DomainError("关系网存在自身或重复关系"); edges.add(key);
    }
  }
}

export function active() {
  const item = one("SELECT * FROM character_versions WHERE status = 'published' ORDER BY id DESC LIMIT 1");
  if (!item) throw new DomainError("no published character version");
  return parse(item);
}

export function portrait(): CharacterProfile {
  const current = active();
  const profile = current.profile as unknown as Omit<CharacterProfile, "growth" | "version">;
  const knowledge = characterKnowledge(profile);
  return { ...profile, knowledge_familiar: knowledge.familiar, knowledge_unfamiliar: knowledge.unfamiliar, growth: current.growth, version: Number(current.id) };
}

export function versions() {
  return rows("SELECT * FROM character_versions ORDER BY id DESC").map(parse);
}

export function createDraft(name: string, profile: Record<string, unknown>, author = "admin"): number {
  assertProfile(profile);
  return run(
    "INSERT INTO character_versions(name, profile, growth, status, author, created_at) VALUES(?, ?, ?, 'draft', ?, ?)",
    name.slice(0, 120),
    JSON.stringify(profile),
    JSON.stringify(active().growth),
    author,
    isoNow(),
  ).lastId;
}

export function publish(versionId: number) {
  const item = one("SELECT * FROM character_versions WHERE id = ?", versionId);
  if (!item) throw new DomainError("character version not found");
  const profile = JSON.parse(String(item.profile)) as Record<string, unknown>;
  assertProfile(profile);
  transaction(() => {
    run("UPDATE character_versions SET status = 'archived' WHERE status = 'published'");
    run("UPDATE character_versions SET status = 'published', published_at = ? WHERE id = ?", isoNow(), versionId);
    run(
      "UPDATE settings SET value = ?, updated_at = ? WHERE key = 'fixed_character'",
      JSON.stringify(profile),
      isoNow(),
    );
    // Keep generated public biography facts consistent with the version the user published.
    for (const [predicate, value] of [["职业", profile.occupation], ["常住城市", profile.city], ["年龄", profile.age]]) {
      const current = one("SELECT * FROM world_facts WHERE scope = 'character' AND subject = ? AND predicate = ? AND status = 'active'", String(profile.name), predicate);
      if (current && (String(current.object) === String(value) || !["system_seed", "character_profile"].includes(String(current.source)))) continue;
      const factId = run(
        `INSERT INTO world_facts(subject, predicate, object, scope, status, source, conflict_with, created_at)
         VALUES(?, ?, ?, 'character', 'proposed', 'character_profile', ?, ?)`,
        String(profile.name), predicate, String(value), current?.id ?? null, isoNow(),
      ).lastId;
      if (current) run("UPDATE world_facts SET status = 'superseded', superseded_by = ?, reviewed_at = ? WHERE id = ?", factId, isoNow(), current.id);
      run("UPDATE world_facts SET status = 'active', reviewed_at = ? WHERE id = ?", isoNow(), factId);
    }
  });
  audit("character_published", { version_id: versionId });
  return active();
}

export function addGrowthEvidence(attribute: string, proposedValue: string, evidenceDate: string, summary: string, sourceEventId: number | null = null): number {
  const key = attribute.trim();
  const value = proposedValue.trim();
  if (!key || !value || !summary.trim()) throw new DomainError("成长证据字段不能为空");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(evidenceDate)) throw new DomainError("evidence date must be YYYY-MM-DD");
  if (LOCKED.has(key)) throw new DomainError("核心人格字段不能由成长证据修改");
  return run(
    `INSERT INTO growth_evidence(attribute, proposed_value, evidence_date, summary, source_event_id, created_at)
     VALUES(?, ?, ?, ?, ?, ?)`,
    key.slice(0, 80),
    value.slice(0, 500),
    evidenceDate,
    summary.slice(0, 1000),
    sourceEventId,
    isoNow(),
  ).lastId;
}

export function growthEvidence(attribute = "") {
  return rows(
    `SELECT * FROM growth_evidence
     WHERE (? = '' OR attribute = ?) ORDER BY evidence_date DESC, id DESC`,
    attribute,
    attribute,
  );
}

/**
 * Growth never edits the published persona in place. Two independent dates are
 * required, then a reviewable character draft is created for an admin to publish.
 */
export function applyGrowth(attribute: string, proposedValue: string, author = "admin"): number {
  const key = attribute.trim();
  const value = proposedValue.trim();
  if (!key || !value) throw new DomainError("成长属性和值不能为空");
  if (LOCKED.has(key)) throw new DomainError("核心人格字段不能由成长证据修改");
  const evidence = rows(
    `SELECT * FROM growth_evidence
     WHERE attribute = ? AND proposed_value = ? AND status = 'active'
     ORDER BY evidence_date DESC, id DESC`,
    key,
    value,
  );
  const distinctDates = new Set(evidence.map((item) => String(item.evidence_date)));
  if (distinctDates.size < 2) throw new DomainError("至少需要两个不同日期的成长证据");
  const current = active();
  const growth = { ...current.growth, [key]: value };
  const created = run(
    `INSERT INTO character_versions(name, profile, growth, status, author, created_at)
     VALUES(?, ?, ?, 'draft', ?, ?)`,
    `成长草稿：${key}`.slice(0, 120),
    JSON.stringify(current.profile),
    JSON.stringify(growth),
    author.slice(0, 80),
    isoNow(),
  ).lastId;
  run(
    `UPDATE growth_evidence SET status = 'applied'
     WHERE attribute = ? AND proposed_value = ? AND status = 'active'`,
    key,
    value,
  );
  audit("character_growth_draft_created", { version_id: created, attribute: key, evidence_ids: evidence.map((item) => item.id) }, author);
  return created;
}
