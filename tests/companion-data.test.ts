import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { applyCompanionData } from "../packages/world/src/bootstrap/apply";

process.env.DEEPSEEK_API_KEY = "";
process.env.HARNESS_ADMIN_TOKEN = "complete-data-test";

async function fixture() {
  const cached = globalThis as unknown as { harnessDb?: DatabaseSync };
  cached.harnessDb?.close(); delete cached.harnessDb;
  process.env.HARNESS_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(),"companion-data-test-")),"test.sqlite3");
  const db = await import("@infra/db"); db.ready();
  return {db, raw:cached.harnessDb!, now:(await import("@shared/time")).isoNow()};
}

test("fresh configuration is complete and reopening or reapplying never duplicates it", async () => {
  const {db,raw,now} = await fixture();
  const role = (await import("@character")).portrait();
  assert.equal(role.age,21); assert.equal(role.occupation,"大学生");
  for (const key of ["school","major","family_background","food_preferences","birthday","childhood","personality_origins","romantic_history","conflict_style"]) assert.ok((role as any)[key]);
  assert.equal(role.life_experiences?.length,9); assert.equal(role.relationship_network?.length,8);
  assert.equal(db.one("SELECT count(*) AS n FROM character_versions WHERE status='published'")?.n,1);
  assert.equal(db.one("SELECT count(*) AS n FROM npcs")?.n,5);
  assert.equal(db.one("SELECT count(*) AS n FROM goals WHERE status='active'")?.n,3);
  assert.equal(db.one("SELECT count(*) AS n FROM story_events WHERE kind='plan'")?.n,3);
  assert.equal(db.one("SELECT count(*) AS n FROM growth_evidence")?.n,0);
  const first = applyCompanionData(raw,now);
  assert.deepEqual(Object.values(first.created),[0,0,0,0]);
  assert.deepEqual(Object.values(first.updated),[0,0,0]);
  const {databasePath} = await import("@shared/config");
  const location = databasePath();
  const cached = globalThis as unknown as {harnessDb?:DatabaseSync}; cached.harnessDb?.close(); delete cached.harnessDb;
  process.env.HARNESS_DB_PATH=location; db.ready();
  assert.equal(db.one("SELECT count(*) AS n FROM goals")?.n,3);
  assert.equal(db.one("SELECT count(*) AS n FROM story_events")?.n,3);
  assert.equal(db.rows("PRAGMA foreign_key_check").length,0);
});

test("reapplying preserves administrator edits, progress and private user data", async () => {
  const {db,raw,now} = await fixture();
  const {getOrCreateUser} = await import("@people/users");getOrCreateUser("private-preserved","私有用户");
  db.run("INSERT INTO messages(user_id,channel,role,content,created_at) VALUES('private-preserved','web','user','不可公开的私有内容',?)",now);
  (await import("@memory")).remember("private-preserved","私有偏好验收","fact");
  db.run("UPDATE npcs SET profile='管理员自己的阿宁设定' WHERE name='阿宁'");
  db.run("UPDATE goals SET progress=35 WHERE title='练习街头摄影'");
  db.run("UPDATE schedule_templates SET enabled=0 WHERE title='自由时间'");
  const before = db.rows("SELECT * FROM messages");
  const report = applyCompanionData(raw,now);
  assert.ok(report.preserved.includes("npcs:aning"));
  assert.ok(report.preserved.includes("goals:photography"));
  assert.equal(db.one("SELECT profile FROM npcs WHERE name='阿宁'")?.profile,"管理员自己的阿宁设定");
  assert.equal(db.one("SELECT progress FROM goals WHERE title='练习街头摄影'")?.progress,35);
  assert.equal(db.one("SELECT enabled FROM schedule_templates WHERE title='自由时间'")?.enabled,0);
  assert.deepEqual(db.rows("SELECT * FROM messages"),before);
  assert.equal(db.one("SELECT count(*) AS n FROM memories WHERE user_id='private-preserved'")?.n,1);
});

test("legacy bootstrap duplicates are archived without deleting history or repeating on reopen", async () => {
  const {db,raw,now}=await fixture();
  db.run("DELETE FROM story_events");db.run("DELETE FROM goals");db.run("DELETE FROM data_pack_entries WHERE resource_type='goals'");
  for(let index=0;index<5;index+=1) db.run("INSERT INTO goals(title,description,status,progress,updated_at) VALUES('练习街头摄影','每周安排一次练习，逐步形成自己的观察方式','active',10,?)",now);
  const report=applyCompanionData(raw,now);
  assert.equal(report.archived_goal_ids.length,4);
  assert.equal(db.one("SELECT count(*) AS n FROM goals WHERE status='archived'")?.n,4);
  assert.equal((await import("@world/stories")).listGoals().length,3);
  assert.equal(applyCompanionData(raw,now).archived_goal_ids.length,0);
});

test("data pack publication rolls back entirely if any resource fails to save",async(t)=>{
  const {db,raw,now}=await fixture();
  db.run("DELETE FROM npcs WHERE name='周敏'");
  const role=(await import("@character")).active(); const profile={...role.profile};delete profile.major;
  db.run("UPDATE character_versions SET profile=? WHERE id=?",JSON.stringify(profile),role.id);
  db.run("CREATE TRIGGER fail_pack_person BEFORE INSERT ON npcs WHEN NEW.name='周敏' BEGIN SELECT RAISE(ABORT,'test pack storage failure'); END");
  t.after(()=>db.run("DROP TRIGGER IF EXISTS fail_pack_person"));
  assert.throws(()=>applyCompanionData(raw,now),/test pack storage failure/);
  assert.equal((await import("@character")).active().id,role.id);
  assert.equal((await import("@character")).active().profile.major,undefined);
  assert.equal(db.one("SELECT count(*) AS n FROM npcs")?.n,4);
});

test("context retrieves role relations and goals without confusing the user's own people",async()=>{
  const {db}=await fixture();
  const {compilePrompt}=await import("@prompting");
  const {profiles}=await import("@world/npc");const {listGoals}=await import("@world/stories");
  const {activeFacts}=await import("@world/lore");
  const base={user:{display_name:"聊天"},memories:[],events:[],mood:"平静",npcs:profiles(),goals:listGoals(),worldFacts:activeFacts()};
  assert.match(compilePrompt({...base,userMessage:"你的室友是谁"}).system,/许棠/u);
  assert.match(compilePrompt({...base,userMessage:"你姐姐是做什么的"}).system,/林晚晴/u);
  assert.match(compilePrompt({...base,userMessage:"你爸是做什么的"}).system,/林建平/u);
  assert.match(compilePrompt({...base,userMessage:"你家里都有谁？名字和做什么的也说说"}).system,/林建平/u);
  assert.match(compilePrompt({...base,userMessage:"你俩闹过什么小矛盾，具体说一件",history:[{role:"user",content:"你的室友叫什么？性格怎么样？"}]}).system,/台灯/u);
  assert.match(compilePrompt({...base,userMessage:"你当初为什么选这个专业？",history:[{role:"user",content:"你在哪读书，学什么，大几了？"}]}).system,/班级活动海报/u);
  assert.match(compilePrompt({...base,userMessage:"你小时候有什么有意思的经历"}).system,/书店等妈妈|废纸背面/u);
  assert.match(compilePrompt({...base,userMessage:"你和阿宁怎么认识的"}).system,/校园公开作品交流/u);
  assert.match(compilePrompt({...base,userMessage:"你最近有什么目标"}).system,/作品集|下一步/u);
  for(const query of ["你好","好吧","我室友小周把伞借出去了","我小时候最喜欢跑操场"]){
    assert.doesNotMatch(compilePrompt({...base,userMessage:query}).system,/许棠|林晚晴|周敏|澄光图书室|完成本学期课程作品集|bookshop-childhood|roommate-boundary/u);
  }
  const text=compilePrompt({...base,userMessage:"我的室友叫谁来着"}).system;
  assert.doesNotMatch(text,/许棠/u);
  assert.equal(db.one("SELECT count(*) AS n FROM memories")?.n,0);
});

test("thirty-day public life templates are consistent, isolated and repeatable",async()=>{
  const {db}=await fixture();const world=await import("@world/daily-life");const {shiftDate,businessDate}=await import("@shared/time");
  for(let offset=0;offset<30;offset++){
    const day=shiftDate(businessDate(),offset);const first=world.ensureDailySkeleton(day,"sandbox");
    assert.deepEqual(world.ensureDailySkeleton(day,"sandbox"),first);
    assert.ok(first.length>=4);assert.ok(first.every((item)=>item.status==="planned"));
    assert.ok(first.every((item)=>!item.title.includes("插画工作")));
    const ranges=first.filter((item)=>item.start_time).map((item)=>({start:item.start_time!,end:item.end_time??item.start_time!})).sort((a,b)=>a.start.localeCompare(b.start));
    for(let index=1;index<ranges.length;index++)assert.ok(ranges[index].start>=ranges[index-1].end,`日程冲突：${day}`);
    assert.equal(world.events(day).length,0);
  }
  assert.equal(db.one("SELECT count(*) AS n FROM growth_evidence")?.n,0);
  assert.equal(db.one("SELECT sum(progress) AS n FROM goals WHERE status='active'")?.n,0);
});

test("complete public character data cannot crowd a user's older memory out of the context",async()=>{
  const {db}=await fixture();const {getOrCreateUser}=await import("@people/users");const memory=await import("@memory");
  getOrCreateUser("recall-owner","记忆主人");getOrCreateUser("recall-other","其他用户");
  const id=memory.remember("recall-owner","用户最喜欢的植物是蓝花楹","interest",2);
  memory.remember("recall-other","用户最喜欢的植物是紫藤","interest",5);
  for(let index=0;index<110;index++)memory.remember("recall-owner",`其他近期事项${index}`,"fact",5);
  const {buildContext}=await import("@core/context");
  const context=buildContext("recall-owner","我最喜欢的植物是什么来着");
  assert.ok(context.memories.some((item)=>item.id===id));
  assert.ok(context.memories.every((item)=>!item.text.includes("紫藤")));
  assert.ok(context.estimated_tokens<=context.budget);
  const {compilePrompt}=await import("@prompting");
  assert.match(compilePrompt({user:{display_name:"聊天"},memories:context.memories,events:context.world_events,mood:"平静",userMessage:"我最喜欢的植物是什么来着"}).system,/蓝花楹/u);
  assert.equal(db.one("SELECT count(*) AS n FROM npcs")?.n,5);
});

test("one character's biography, relationships and optional prompts survive editing and publication",async()=>{
  const {db}=await fixture();const character=await import("@character");const prompting=await import("@prompting");
  const original=character.active();const profile=original.profile;
  const names=new Set([String(profile.name),...db.rows("SELECT name FROM npcs").map(item=>String(item.name))]);
  for(const relation of profile.relationship_network as any[])for(const name of [relation.from,relation.to])assert.ok(names.has(name),`关系网人物没有档案：${name}`);
  for(const event of profile.life_experiences as any[])for(const name of event.people)assert.ok(names.has(name),`经历人物没有档案：${name}`);
  const draft=character.createDraft("当前角色完整资料修订",{...profile,comforts:"安静一会儿，听两首熟悉的歌"});character.publish(draft);
  assert.deepEqual(character.active().profile.life_experiences,profile.life_experiences);
  assert.deepEqual(character.active().profile.relationship_network,profile.relationship_network);
  assert.equal(db.one("SELECT count(*) AS n FROM character_versions WHERE status='published'")?.n,1);
  const before=prompting.activePrompt();assert.equal(Object.keys(before.modules).length,11);
  const promptDraft=prompting.createBundle("经历规则修订",{biography_context:before.moduleText.biography_context+"保持经历阶段一致。"});
  prompting.publishBundle(promptDraft);const after=prompting.activePrompt();
  assert.match(after.moduleText.biography_context,/保持经历阶段一致/u);
  for(const key of ["identity","voice","facts","privacy","social","capability"])assert.equal(after.moduleText[key],before.moduleText[key]);
});

test("world tree and administrative APIs expose public configuration and enforce authentication",async()=>{
  await fixture();const {handle}=await import("@gateway");
  const get=(authorized:boolean)=>handle(new Request("http://localhost/api/world/tree",{headers:authorized?{Authorization:"Bearer complete-data-test"}:{}}),["world","tree"]);
  assert.equal((await get(false)).status,401);
  const response=await get(true);assert.equal(response.status,200);
  const body=await response.json();assert.equal(body.summary.npcs,5);assert.equal(body.summary.active_goals,3);
  assert.ok(JSON.stringify(body.tree).includes("下一步"));
  assert.ok(!JSON.stringify(body).includes("private-preserved"));
  assert.equal(body.summary.experiences,9);assert.equal(body.summary.relations,8);
  assert.ok(!JSON.stringify(body).includes("[object Object]"));
});

test("goal lifecycle validates progress, records clamped deltas, and never counts mere plans as execution",async()=>{
  const {db}=await fixture();const goals=await import("@world/stories");
  assert.ok(goals.review().every((item)=>item.action==="schedule_opportunity"));
  for(const input of [["",0],["坏进度",101],["非整数",1.2]] as const) assert.throws(()=>goals.createGoal(input[0],"","active",input[1]));
  assert.throws(()=>goals.createGoal("假完成","","completed",0));
  const id=goals.createGoal("测试完整目标","说明","active",90,{stage:"doing",milestones:["一步"]});
  goals.advance(id,"最后一部分完成",50);
  assert.equal(db.one("SELECT progress,status FROM goals WHERE id=?",id)?.status,"completed");
  assert.equal(db.one("SELECT progress_delta FROM story_events WHERE goal_id=?",id)?.progress_delta,10);
  goals.advance(id,"需要回去修订",-10);
  assert.equal(db.one("SELECT status FROM goals WHERE id=?",id)?.status,"active");
  db.run("UPDATE goals SET status='paused' WHERE id=?",id);
  assert.throws(()=>goals.advance(id,"不能推进",1),/暂停/u);
});

test("NPC and story evidence cannot promote private or unfinished events into shared history",async()=>{
  const {db}=await fixture();const {getOrCreateUser}=await import("@people/users");getOrCreateUser("owner","私有");
  const world=await import("@world/daily-life");const people=await import("@world/npc");const goals=await import("@world/stories");
  const npc=people.profiles()[0];const goal=goals.listGoals()[0];
  const event=world.addEvent({title:"用户私有经历",shareLevel:"private",userId:"owner",status:"completed"});
  assert.throws(()=>people.recordEvent(npc.id,"不可共享",1,event),/公开/u);
  assert.throws(()=>goals.advance(goal.id,"不可共享",1,"progress",event),/公开/u);
  assert.equal(db.one("SELECT count(*) AS n FROM npc_events")?.n,0);
  const publicEvent=world.addEvent({title:"公开活动",status:"completed"});
  people.recordEvent(npc.id,"已确认的公开交流",1,publicEvent);
  goals.advance(goal.id,"已确认的目标进展",10,"progress",publicEvent);
  assert.equal(people.profiles()[0].relationship_score,1);
});

test("invalid schedules and role fields are rejected, and global mood settings reach the chat state",async()=>{
  await fixture();const world=await import("@world/daily-life");const character=await import("@character");
  assert.throws(()=>world.saveScheduleTemplate({title:"坏时间",startTime:"25:90"}));
  assert.throws(()=>world.addEvent({title:"坏日期",day:"2031-02-30"}));
  assert.throws(()=>world.addEvent({title:"坏时段",startTime:"12:00",endTime:"11:00"}));
  assert.throws(()=>character.createDraft("坏年龄",{...character.active().profile,age:"NaN"}));
  const profile=character.active().profile;
  assert.throws(()=>character.createDraft("未来当经历",{...profile,life_experiences:[{...(profile.life_experiences as any[])[0],age_end:25}]}));
  assert.throws(()=>character.createDraft("关系重复",{...profile,relationship_network:[...(profile.relationship_network as any[]),(profile.relationship_network as any[])[0]]}));
  assert.doesNotThrow(()=>character.createDraft("完整当前角色背景",profile));
  const mood=await import("@world/emotion");mood.setGlobalMood("今天有点轻松");
  assert.equal(mood.current().global.mood,"今天有点轻松");
});
