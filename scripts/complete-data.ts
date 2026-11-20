import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { databasePath, projectRoot } from "@shared/config";
import { isoNow } from "@shared/time";
import { applyCompanionData } from "../packages/world/src/bootstrap/apply";
import { ROLE_FIELD_LABELS } from "../packages/character/src/fields";

async function main() {
  const apply = process.argv.includes("--apply");
  const sourcePath = databasePath();
  const destination = apply ? path.join(projectRoot(),"data","backups",`before-complete-data-${Date.now()}.sqlite3`) : path.join(mkdtempSync(path.join(tmpdir(),"companion-data-preview-")),"preview.sqlite3");
  mkdirSync(path.dirname(destination),{recursive:true});
  const source = new DatabaseSync(sourcePath,{readOnly:true});
  source.exec("PRAGMA busy_timeout=5000");
  source.exec(`VACUUM INTO '${destination.replaceAll("'","''")}'`);
  source.close();
  const backup = new DatabaseSync(destination,{readOnly:true});
  assert.equal(backup.prepare("PRAGMA integrity_check").get()!.integrity_check,"ok"); backup.close();
  process.env.HARNESS_DB_PATH = apply ? sourcePath : destination;
  const domain = await import("@infra/db"); domain.ready();
  const target = new DatabaseSync(apply ? sourcePath : destination);
  target.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
  const count = () => Object.fromEntries(["goals","npcs","world_facts","schedule_templates","messages","memories"].map(table=>[table,target.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n]));
  const before = count();
  const report = applyCompanionData(target,isoNow());
  const after = count();
  assert.equal(target.prepare("PRAGMA integrity_check").get()!.integrity_check,"ok");
  assert.equal(target.prepare("PRAGMA foreign_key_check").all().length,0);
  target.close();
  const {worldTree}=await import("../packages/world/src/lore/tree");
  const {portrait}=await import("@character");
  const profile=portrait();
  const emptyFields=Object.entries(profile).filter(([key,value])=>!["growth","version"].includes(key) && (value==null || value==="" || Array.isArray(value)&&!value.length)).map(([key])=>key);
  const configuration={...worldTree().summary,profile_fields:Object.keys(profile).filter(key=>!["growth","version"].includes(key)).length,empty_fields:emptyFields,private_data_unchanged:true};
  assert.deepEqual(emptyFields,[],"仍有空白角色配置");
  const result = {applied:apply,backup:apply?destination:undefined,before,after,report,configuration};
  mkdirSync(path.join(projectRoot(),"data"),{recursive:true});
  writeFileSync(path.join(projectRoot(),"data",apply?"complete-data-applied.json":"complete-data-preview.json"),JSON.stringify(result,null,2));
  if(apply){
    const text=[`# ${profile.name}当前角色配置`,``, `角色版本：${profile.version}。这是同一位角色的公开设定，不包含真实用户的聊天和记忆。`,``,
      ...Object.entries(profile).filter(([key,value])=>!["version","growth"].includes(key)&&!Array.isArray(value)).flatMap(([key,value])=>[`## ${ROLE_FIELD_LABELS[key]??key}`,``,String(value),``]),
      `## 成长经历`, ``,...(profile.life_experiences??[]).flatMap(item=>[`### ${item.age_start}–${item.age_end}岁：${item.title}`,``,item.event,``,`性格影响：${item.impact}`,``,`相关人物：${item.people.join("、")||"个人经历"}`,``]),
      `## 家人朋友关系网`,``,...(profile.relationship_network??[]).flatMap(item=>[`### ${item.from} ↔ ${item.to}（${item.relation}）`,``,`${item.closeness}。${item.interaction}`,``,`边界：${item.boundary}`,``]),
      `## 目标、亲友档案、生活模板与世界设定`,``];
    function appendNodes(nodes:ReturnType<typeof worldTree>["tree"],depth=0){for(const node of nodes){text.push(`${"  ".repeat(depth)}- **${node.label}**${node.value?`：${node.value}`:""}`);if(node.children)appendNodes(node.children,depth+1);}}
    appendNodes(worldTree().tree.filter(node=>!["character","biography","relations"].includes(node.id)));
    mkdirSync(path.join(projectRoot(),"docs"),{recursive:true});
    writeFileSync(path.join(projectRoot(),"docs","CURRENT_CHARACTER.md"),text.join("\n"));
  }
  console.log(JSON.stringify(result,null,2));
}
main().catch((error:unknown)=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
