import { activeFacts } from "./facts";
import { portrait } from "@character";
import { listGoals } from "@world/stories";
import { profiles } from "@world/npc";
import { scheduleTemplates } from "@world/daily-life";
import { current } from "@world/emotion";
import { one } from "@infra/db";
import { ROLE_FIELD_LABELS } from "../../../character/src/fields";

export interface WorldNode { id: string; label: string; kind: string; value?: string; status?: string; children?: WorldNode[] }

/** This is a projection of the public configuration, never of real users' private memory. */
export function worldTree() {
  const role = portrait();
  const facts = activeFacts(1000);
  const people = profiles();
  const goals = listGoals();
  const schedules = scheduleTemplates().filter((item) => item.enabled);
  const grouped: WorldNode[] = [...new Set(facts.map((fact) => fact.scope))].map((scope) => ({
    id: `scope:${scope}`, label: ({ global: "世界背景", character: "身份事实", location: "地点", organization: "学校与社团", npc: "人物设定" } as Record<string,string>)[scope] ?? scope, kind: "scope",
    children: [...new Set(facts.filter((fact) => fact.scope === scope).map((fact) => fact.subject))].map((subject) => ({ id: `${scope}:${subject}`, label: subject, kind: "entity", children: facts.filter((fact) => fact.scope === scope && fact.subject === subject).map((fact) => ({ id: `fact:${fact.id}`, label: fact.predicate, value: fact.object, kind: "fact", status: fact.status })) })),
  }));
  const tree: WorldNode[] = [
    { id: "character", label: `${role.name}的角色档案`, kind: "character", children: Object.entries(role).filter(([key,value]) => !["version","growth"].includes(key) && !Array.isArray(value)).map(([key,value]) => ({ id: `profile:${key}`, label: ROLE_FIELD_LABELS[key] ?? key, value: String(value), kind: "field" })) },
    {id:"biography",label:"成长经历",kind:"biography",children:(role.life_experiences??[]).map((item)=>({id:`experience:${item.id}`,label:`${item.age_start}–${item.age_end}岁 · ${item.title}`,value:item.event,kind:"experience",children:[{id:`experience:${item.id}:impact`,label:"性格与习惯的影响",value:item.impact,kind:"impact"},{id:`experience:${item.id}:people`,label:"相关人物",value:item.people.join("、")||"个人经历",kind:"people"}]}))},
    {id:"relations",label:"家人朋友关系网",kind:"relations",children:(role.relationship_network??[]).map((item,index)=>({id:`relation:${index}`,label:`${item.from} ↔ ${item.to} · ${item.relation}`,value:`${item.closeness}；${item.interaction}`,kind:"relation",children:[{id:`relation:${index}:boundary`,label:"相处边界",value:item.boundary,kind:"boundary"}]}))},
    { id: "world", label: "世界设定", kind: "world", children: grouped },
    { id: "people", label: "固定人物关系", kind: "people", children: people.map((npc) => ({ id: `npc:${npc.id}`, label: npc.name, kind: "npc", value: `${npc.relationship} · ${npc.profile}`, children: npc.events.map((event: any) => ({ id:`npc-event:${event.id}`,label:event.event_date,value:event.summary,kind:"event" })) })) },
    { id: "goals", label: "目标与故事", kind: "goals", children: goals.map((goal) => ({ id:`goal:${goal.id}`,label:goal.title,kind:"goal",status:goal.status,value:`${goal.stage} · ${goal.progress}% · ${goal.description}`,children:[{id:`goal:${goal.id}:next`,label:"下一步",kind:"plan",value:goal.next_action},{id:`goal:${goal.id}:obstacle`,label:"当前障碍",kind:"plan",value:goal.obstacle},...goal.milestones.map((text:string,index:number)=>({id:`goal:${goal.id}:step:${index}`,label:`计划步骤 ${index+1}`,kind:"milestone",value:text})),...goal.events.map((event:any)=>({id:`story-event:${event.id}`,label:`${event.event_date} · ${event.kind}`,kind:"event",value:event.summary}))] })) },
    { id: "schedules", label: "生活日程模板", kind: "schedules", children: schedules.map((item) => ({id:`schedule:${item.id}`,label:`${item.weekday == null ? "每天" : `星期${Number(item.weekday)+1}`} ${item.start_time} ${item.title}`,value:`${item.details} · ${Math.round(Number(item.probability)*100)}%`,kind:"schedule"})) },
    { id: "emotion",label:"基础情绪",kind:"emotion",value:`${current().global.mood} · ${current().global.reason ?? ""}` },
  ];
  return { tree, summary: { role_version: role.version, facts: facts.length, npcs: people.length, experiences:role.life_experiences?.length??0,relations:role.relationship_network?.length??0,active_goals: goals.filter((goal) => goal.status === "active").length, schedules: schedules.length, prompt_version: Number(one("SELECT id FROM prompt_bundles WHERE status='published' ORDER BY id DESC LIMIT 1")?.id ?? 0) } };
}
