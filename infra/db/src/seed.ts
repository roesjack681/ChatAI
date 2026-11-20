import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { CORE_PROMPTS, EXTRA_PROMPTS, ROLE_DEFAULTS } from "../../../packages/world/src/bootstrap/catalog";
import { applyCompanionData } from "../../../packages/world/src/bootstrap/apply";

export function seed(db: DatabaseSync, now: string): void {
  const bind = (values: unknown[]) => values.map((value) => value == null ? null : value) as SQLInputValue[];
  const run = (sql: string, ...values: unknown[]) => db.prepare(sql).run(...bind(values));
  const get = (sql: string, ...values: unknown[]) => db.prepare(sql).get(...bind(values)) as Record<string, any> | undefined;
  const fresh = !get("SELECT id FROM character_versions LIMIT 1");
  run("INSERT OR IGNORE INTO settings(key,value,updated_at) VALUES('fixed_character',?,?)", JSON.stringify(ROLE_DEFAULTS), now);
  run("INSERT OR IGNORE INTO settings(key,value,updated_at) VALUES('global_mood','平静、专注',?)", now);
  run("INSERT OR IGNORE INTO settings(key,value,updated_at) VALUES('prompt_version','1',?)", now);
  run("INSERT OR IGNORE INTO settings(key,value,updated_at) VALUES('immersive_mode','true',?)", now);
  run("INSERT OR IGNORE INTO prompts(version,name,content,status,created_at,published_at) VALUES(1,'默认角色对话',?,'published',?,?)", CORE_PROMPTS.identity, now, now);
  run("INSERT OR IGNORE INTO channel_configs(channel,enabled,mode,capabilities,config,updated_at) VALUES('web',1,'sync',?,'{}',?)", JSON.stringify({reply:true,proactive:false,voice:false}), now);
  run("INSERT OR IGNORE INTO schema_migrations(version,name,applied_at) VALUES(1,'initial_complete_schema',?)", now);
  if (!get("SELECT id FROM emotion_states WHERE scope='global' LIMIT 1")) run("INSERT INTO emotion_states(scope,mood,valence,arousal,reason,created_at) VALUES('global','平静',0.2,-0.2,'初始基础情绪',?)", now);
  if (fresh) run("INSERT INTO character_versions(name,profile,growth,status,author,created_at,published_at) VALUES('初始角色版本',?,'{}','published','system',?,?)", get("SELECT value FROM settings WHERE key='fixed_character'")!.value, now, now);
  const modules = {...CORE_PROMPTS,...EXTRA_PROMPTS};
  for (const [key,content] of Object.entries(modules)) run("INSERT OR IGNORE INTO prompt_modules(module_key,version,content,status,created_at,published_at) VALUES(?,1,?,'published',?,?)", key, content, now, now);
  if (!get("SELECT id FROM prompt_bundles LIMIT 1")) run("INSERT INTO prompt_bundles(name,module_versions,status,created_at,published_at) VALUES('默认完整 Bundle',?,'published',?,?)", JSON.stringify(Object.fromEntries(Object.keys(modules).map(key => [key,1]))), now, now);
  // Data is installed once. Reopening the DB must not recreate deleted or edited content.
  if (fresh) {
    const profile = JSON.parse(String(get("SELECT profile FROM character_versions WHERE status='published'")!.profile));
    run("INSERT OR IGNORE INTO world_facts(subject,predicate,object,scope,status,source,confidence,created_at,reviewed_at) VALUES(?,'身份','平台固定虚拟角色','character','active','system_seed',1,?,?)", profile.name, now, now);
    run("INSERT OR IGNORE INTO world_facts(subject,predicate,object,scope,status,source,confidence,created_at,reviewed_at) VALUES('世界时间','时区','Asia/Shanghai','global','active','system_seed',1,?,?)", now, now);
    if (/大学|学生/u.test(String(profile.occupation))) applyCompanionData(db, now);
  }
}
