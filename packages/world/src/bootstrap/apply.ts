import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { CORE_PROMPTS, EXTRA_PROMPTS, GOAL_DATA, NPC_DATA, PACK_KEY, PACK_VERSION, ROLE_DEFAULTS, SCHEDULE_DATA, WORLD_DATA } from "./catalog";

type Row = Record<string, any>;
function fingerprint(value: unknown): string {
  const stable = (value: any): any => Array.isArray(value) ? value.map(stable) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])) : value;
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

/** No domain imports: also usable during the first database bootstrap. */
export function applyCompanionData(db: DatabaseSync, now: string) {
  const args = (values: unknown[]) => values.map((value) => value == null ? null : value) as SQLInputValue[];
  const one = (sql: string, ...values: unknown[]) => db.prepare(sql).get(...args(values)) as Row | undefined;
  const all = (sql: string, ...values: unknown[]) => db.prepare(sql).all(...args(values)) as Row[];
  const run = (sql: string, ...values: unknown[]) => db.prepare(sql).run(...args(values));
  const report = { pack: PACK_KEY, version: PACK_VERSION, created: { npcs: 0, goals: 0, facts: 0, schedules: 0 }, updated: { npcs: 0, goals: 0, schedules: 0 }, preserved: [] as string[], archived_goal_ids: [] as number[], disabled_schedule_ids: [] as number[], retired_event_ids: [] as number[], character_version: 0, prompt_version: 0 };
  db.exec("BEGIN IMMEDIATE");
  try {
    const privateTables = ["users","messages","message_images","memories","relationships","relationship_events","identities","commitments","user_portraits","preferences"];
    const privateHash = () => fingerprint([...privateTables.map((table)=>[table,all(`SELECT * FROM ${table} ORDER BY rowid`)]),["private_world_events",all("SELECT * FROM world_events WHERE share_level='private' ORDER BY id")]]);
    const beforePrivate = privateHash();
    const active = one("SELECT * FROM character_versions WHERE status = 'published' ORDER BY id DESC LIMIT 1")!;
    const previous = JSON.parse(String(active.profile)) as Record<string, unknown>;
    if (!/大学|学生/u.test(String(previous.occupation))) throw new Error("校园数据包仅适用于当前大学生角色，未修改其他职业配置");
    const profile = { ...ROLE_DEFAULTS, ...Object.fromEntries(Object.entries(previous).filter(([, value]) => value !== "" && value != null)) };
    if (previous.knowledge_familiar === "角色档案明确写出的工作与生活经验，以及普通日常常识") profile.knowledge_familiar = ROLE_DEFAULTS.knowledge_familiar;
    if (fingerprint(profile) !== fingerprint(previous)) {
      const version = Number(run("INSERT INTO character_versions(name, profile, growth, status, author, created_at, published_at) VALUES(?, ?, ?, 'draft', 'companion_data_pack', ?, ?)", "校园生活完整档案", JSON.stringify(profile), active.growth, now, now).lastInsertRowid);
      run("UPDATE character_versions SET status = 'archived' WHERE status = 'published'");
      run("UPDATE character_versions SET status = 'published' WHERE id = ?", version);
      run("UPDATE settings SET value = ?, updated_at = ? WHERE key = 'fixed_character'", JSON.stringify(profile), now);
      report.character_version = version;
    } else report.character_version = Number(active.id);

    function managed(type: "npcs" | "goals" | "schedules", key: string, desired: Row, select: (id?: number) => Row | undefined, create: () => number, update: (id: number) => void, adopt: (current: Row) => boolean = () => false) {
      const entry = one("SELECT * FROM data_pack_entries WHERE pack_key = ? AND resource_type = ? AND resource_key = ?", PACK_KEY, type, key);
      let current = entry ? select(Number(entry.entity_id)) : select();
      if (!current) {
        const id = create(); current = select(id)!; report.created[type] += 1;
      } else if (fingerprint(Object.fromEntries(Object.keys(desired).map((field) => [field, current![field]]))) !== fingerprint(desired)) {
        const currentHash = fingerprint(Object.fromEntries(Object.keys(desired).map((field) => [field, current![field]])));
        if ((entry && currentHash === entry.fingerprint) || (!entry && adopt(current))) { update(Number(current.id)); current = select(Number(current.id))!; report.updated[type] += 1; }
        else { report.preserved.push(`${type}:${key}`); return Number(current.id); }
      }
      const hash = fingerprint(Object.fromEntries(Object.keys(desired).map((field) => [field, current![field]])));
      run("INSERT INTO data_pack_entries(pack_key,resource_type,resource_key,entity_id,fingerprint) VALUES(?,?,?,?,?) ON CONFLICT(pack_key,resource_type,resource_key) DO UPDATE SET entity_id=excluded.entity_id,fingerprint=excluded.fingerprint", PACK_KEY, type, key, current.id, hash);
      return Number(current.id);
    }

    for (const item of NPC_DATA) {
      const desired = { name: item.name, profile: item.profile, relationship: item.relationship };
      managed("npcs", item.key, desired,
        (id) => id ? one("SELECT * FROM npcs WHERE id = ?", id) : one("SELECT * FROM npcs WHERE name = ?", item.name),
        () => Number(run("INSERT INTO npcs(name,profile,relationship,updated_at) VALUES(?,?,?,?)", item.name,item.profile,item.relationship,now).lastInsertRowid),
        (id) => { run("UPDATE npcs SET profile=?,relationship=?,updated_at=? WHERE id=?",item.profile,item.relationship,now,id); },
        (current) => item.key === "aning" && current.profile === "知夏的大学好友，做建筑设计，直爽热心" && current.relationship === "friend");
    }

    // Preserve historical rows, but remove exact untouched bootstrap duplicates from active lists.
    const legacy = all("SELECT * FROM goals WHERE title='练习街头摄影' AND description='每周安排一次练习，逐步形成自己的观察方式' AND progress=10 AND status='active' ORDER BY id");
    for (const duplicate of legacy.slice(1)) {
      if (one("SELECT id FROM story_events WHERE goal_id = ? LIMIT 1", duplicate.id)) continue;
      run("UPDATE goals SET status='archived',stage='archived',updated_at=? WHERE id=?",now,duplicate.id);
      report.archived_goal_ids.push(Number(duplicate.id));
    }
    for (const item of GOAL_DATA) {
      const desired = { title: item.title, description: item.description, status: "active", progress: 0, stage: item.stage, obstacle: item.obstacle, next_action: item.next_action, milestones: JSON.stringify(item.milestones) };
      const id = managed("goals",item.key,desired,
        (id) => id ? one("SELECT * FROM goals WHERE id=?",id) : one("SELECT * FROM goals WHERE title=? AND status!='archived' ORDER BY id LIMIT 1",item.title),
        () => Number(run("INSERT INTO goals(title,description,status,progress,stage,obstacle,next_action,milestones,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",...Object.values(desired),now).lastInsertRowid),
        (id) => { run("UPDATE goals SET description=?,status=?,progress=?,stage=?,obstacle=?,next_action=?,milestones=?,updated_at=? WHERE id=?", item.description,"active",0,item.stage,item.obstacle,item.next_action,JSON.stringify(item.milestones),now,id); },
        (current) => item.key === "photography" && legacy.some((row) => row.id === current.id) && !one("SELECT id FROM story_events WHERE goal_id=? LIMIT 1",current.id));
      if (!report.preserved.includes(`goals:${item.key}`) && !one("SELECT id FROM story_events WHERE goal_id=? LIMIT 1",id)) run("INSERT INTO story_events(goal_id,event_date,kind,summary,progress_delta,created_at) VALUES(?,?,'plan',?,0,?)",id,now.slice(0,10),`建立目标计划：${item.next_action}（不代表步骤已完成）`,now);
    }

    const biography = [["年龄",profile.age],["职业",profile.occupation],["常住城市",profile.city]].map(([predicate, object]) => ({subject:String(profile.name),predicate:String(predicate),object:String(object),scope:"character"}));
    for (const fact of [...biography, ...WORLD_DATA]) {
      const current = one("SELECT id, object FROM world_facts WHERE subject=? AND predicate=? AND scope=? AND status='active'",fact.subject,fact.predicate,fact.scope);
      if (current) { if (current.object !== fact.object) report.preserved.push(`facts:${fact.subject}:${fact.predicate}`); continue; }
      run("INSERT INTO world_facts(subject,predicate,object,scope,status,source,confidence,created_at,reviewed_at) VALUES(?,?,?,?,'active',?,1,?,?)",fact.subject,fact.predicate,fact.object,fact.scope,fact.scope === "character" ? "character_profile" : PACK_KEY,now,now);
      report.created.facts += 1;
    }

    const staleTemplates = all("SELECT * FROM schedule_templates WHERE enabled=1 AND ((title='插画工作' AND details='按计划处理手头的插画项目' AND start_time='09:00' AND end_time='18:00' AND category='work') OR (title='开始新的一天' AND details='工作日的早晨，精力尚未完全恢复' AND start_time='08:00' AND end_time='09:00' AND category='routine'))");
    for (const item of staleTemplates) {
      run("UPDATE schedule_templates SET enabled=0 WHERE id=?",item.id); report.disabled_schedule_ids.push(Number(item.id));
      const events = all("SELECT id FROM world_events WHERE source=? AND title=? AND details=? AND share_level='public' AND environment='production' AND event_date>=? AND status IN ('planned','ongoing')",`template:${item.id}`,item.title,item.details,now.slice(0,10));
      for (const event of events) { run("UPDATE world_events SET status='cancelled' WHERE id=?",event.id); report.retired_event_ids.push(Number(event.id)); }
    }
    for (const item of SCHEDULE_DATA) {
      const desired = { weekday:item.weekday,start_time:item.start,end_time:item.end,title:item.title,details:item.details,category:item.category,probability:item.probability,enabled:1 };
      managed("schedules",item.key,desired,
        (id) => id ? one("SELECT * FROM schedule_templates WHERE id=?",id) : one("SELECT * FROM schedule_templates WHERE title=? AND weekday IS ? AND start_time=? ORDER BY id LIMIT 1",item.title,item.weekday,item.start),
        () => Number(run("INSERT INTO schedule_templates(weekday,start_time,end_time,title,details,category,probability,enabled,created_at) VALUES(?,?,?,?,?,?,?,?,?)",...Object.values(desired),now).lastInsertRowid),
        (id) => { run("UPDATE schedule_templates SET weekday=?,start_time=?,end_time=?,title=?,details=?,category=?,probability=?,enabled=? WHERE id=?",...Object.values(desired),id); },
        (current) => item.key === "rest" && current.details === "减少社交活动，结束今天" && current.category === "routine");
    }

    const bundle = one("SELECT * FROM prompt_bundles WHERE status='published' ORDER BY id DESC LIMIT 1")!;
    const mapping = JSON.parse(String(bundle.module_versions)) as Record<string,number>;
    let changed = false;
    for (const [key, content] of Object.entries({...CORE_PROMPTS,...EXTRA_PROMPTS})) {
      if (mapping[key] != null) continue; // Preserve the user's published, tuned modules.
      const version = Number(one("SELECT coalesce(max(version),0)+1 AS n FROM prompt_modules WHERE module_key=?",key)!.n);
      run("INSERT INTO prompt_modules(module_key,version,content,status,created_at,published_at) VALUES(?,?,?,'published',?,?)",key,version,content,now,now);
      mapping[key] = version; changed = true;
    }
    if (changed) {
      const id = Number(run("INSERT INTO prompt_bundles(name,module_versions,status,created_at,published_at) VALUES(?,?,'draft',?,?)","校园生活完整上下文",JSON.stringify(mapping),now,now).lastInsertRowid);
      run("UPDATE prompt_bundles SET status='archived' WHERE status='published'"); run("UPDATE prompt_bundles SET status='published' WHERE id=?",id);
      run("UPDATE settings SET value=?,updated_at=? WHERE key='prompt_version'",String(id),now); report.prompt_version=id;
    } else report.prompt_version=Number(bundle.id);
    const mood = String(one("SELECT value FROM settings WHERE key='global_mood'")?.value ?? "平静");
    if (one("SELECT mood FROM emotion_states WHERE scope='global' ORDER BY id DESC LIMIT 1")?.mood !== mood) run("INSERT INTO emotion_states(scope,mood,valence,arousal,reason,created_at) VALUES('global',?,0.2,-0.2,'全局情绪配置同步',?)",mood,now);
    if (beforePrivate !== privateHash()) throw new Error("数据包改变了私域数据，操作已回滚");
    run("INSERT INTO data_packs(pack_key,version,applied_at,report) VALUES(?,?,?,?) ON CONFLICT(pack_key) DO UPDATE SET version=excluded.version,applied_at=excluded.applied_at,report=excluded.report",PACK_KEY,PACK_VERSION,now,JSON.stringify(report));
    run("INSERT INTO audit_log(actor,action,detail,created_at) VALUES('admin','companion_data_applied',?,?)",JSON.stringify(report),now);
    db.exec("COMMIT");
    return report;
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}
