import assert from "node:assert/strict";
import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {test,type TestContext} from "node:test";
import type {DatabaseSync} from "node:sqlite";

process.env.HARNESS_ADMIN_TOKEN="portrait-admin";
async function fixture(){
  const cache=globalThis as unknown as {harnessDb?:DatabaseSync};cache.harnessDb?.close();delete cache.harnessDb;
  process.env.HARNESS_DB_PATH=path.join(mkdtempSync(path.join(tmpdir(),"user-portrait-test-")),"test.sqlite3");process.env.DEEPSEEK_API_KEY="portrait-test";
  const db=await import("@infra/db");db.ready();const users=await import("@people/users");const memory=await import("@memory");
  users.getOrCreateUser("alice","Alice");users.getOrCreateUser("bob","Bob");
  const now=(await import("@shared/time")).isoNow();
  const message=db.run("INSERT INTO messages(user_id,channel,role,content,created_at) VALUES('alice','web','user','回复短一点，我喜欢摄影',?)",now).lastId;
  db.run("INSERT INTO messages(user_id,channel,role,content,created_at) VALUES('alice','web','assistant','我是21岁的杭州大学生林知夏',?)",now);
  db.run("INSERT INTO messages(user_id,channel,role,content,created_at) VALUES('bob','web','user','另一用户不可外传标记',?)",now);
  memory.remember("alice","用户喜欢摄影","interest",4);memory.remember("bob","另一用户私有偏好标记","interest",4);
  return {db,memory,message,now,portrait:await import("../packages/memory/src/portrait")};
}
function stubModel(t:TestContext,options:{badKeys?:boolean;issues?:string[];beforeReview?:()=>void}={}){
  const sent:string[]=[];
  t.mock.method(globalThis,"fetch",async(_input:unknown,init?:RequestInit)=>{
    const body=JSON.parse(String(init?.body));const system=String(body.messages[0].content);const content=String(body.messages.at(-1).content);sent.push(content);
    let output;
    if(system.includes("核对用户特征")){options.beforeReview?.();output={issues:options.issues??[]};}
    else{const sources=JSON.parse(content) as Array<{key:string;kind:string}>;const key=options.badKeys?"memory:999999":sources.find(item=>item.kind==="memory")!.key;
      output={summary:"用户喜欢摄影，希望聊天回复简短。",summary_evidence_keys:[key,...sources.filter(item=>item.kind==="message").map(item=>item.key)],traits:[{label:"兴趣",value:"喜欢摄影",basis:"explicit",evidence_keys:[key]}]};}
    return Response.json({choices:[{message:{content:JSON.stringify(output)},finish_reason:"stop"}],usage:{prompt_tokens:20,completion_tokens:10}});
  });return sent;
}

test("memory overview is scoped, categorized and does not invent a portrait or use counters",async()=>{
  const {db,portrait}=await fixture();const view=portrait.userMemoryOverview("alice");
  assert.equal(view.user.id,"alice");assert.equal(view.stats.active,1);assert.equal(view.stats.messages,1);
  assert.equal(view.groups[0].label,"兴趣与偏好");assert.equal(view.portrait.status,"empty");
  assert.doesNotMatch(JSON.stringify(view),/另一用户|21岁的杭州/u);
  assert.equal(db.one("SELECT sum(access_count) AS n FROM memories WHERE user_id='alice'")?.n,0);
  assert.throws(()=>portrait.userMemoryOverview("not-found"),/用户不存在/u);
});

test("model portrait has traceable evidence, stays separate from memories and never reads another owner or role",async(t)=>{
  const {db,portrait}=await fixture();const sent=stubModel(t);const before=db.one("SELECT count(*) AS n FROM memories")?.n;
  const view=await portrait.refreshUserPortrait("alice");assert.equal(view.portrait.status,"ready");
  assert.match(view.portrait.summary!,/摄影/u);assert.equal(view.portrait.traits.length,1);
  assert.ok(view.portrait.sources.every(item=>item.kind==="memory"||item.kind==="message"));
  assert.doesNotMatch(sent.join("\n"),/另一用户|21岁的杭州/u);
  assert.equal(db.one("SELECT count(*) AS n FROM memories")?.n,before);
  assert.equal(portrait.userMemoryOverview("bob").portrait.status,"empty");
});

test("new messages mark a portrait stale, deleting evidence hides all derived conclusions",async(t)=>{
  const {db,now,message,portrait}=await fixture();stubModel(t);await portrait.refreshUserPortrait("alice");
  db.run("INSERT INTO messages(user_id,channel,role,content,created_at) VALUES('alice','web','user','我现在也喜欢散步',?)",now);
  assert.equal(portrait.userMemoryOverview("alice").portrait.status,"stale");
  db.run("DELETE FROM messages WHERE id=?",message);
  const invalid=portrait.userMemoryOverview("alice").portrait;assert.equal(invalid.status,"invalidated");assert.equal(invalid.summary,null);assert.deepEqual(invalid.traits,[]);
});

test("unknown references and unsupported model claims cannot overwrite a previous portrait",async(t)=>{
  const {db,portrait}=await fixture();stubModel(t);await portrait.refreshUserPortrait("alice");const before=db.one("SELECT * FROM user_portraits WHERE user_id='alice'");
  t.mock.restoreAll();stubModel(t,{badKeys:true});await assert.rejects(()=>portrait.refreshUserPortrait("alice"));
  assert.deepEqual(db.one("SELECT * FROM user_portraits WHERE user_id='alice'"),before);
  t.mock.restoreAll();stubModel(t,{issues:["来源不支持该结论"]});await assert.rejects(()=>portrait.refreshUserPortrait("alice"));
  assert.deepEqual(db.one("SELECT * FROM user_portraits WHERE user_id='alice'"),before);
});

test("a memory correction while generation is running prevents a stale portrait from being committed",async(t)=>{
  const {db,memory,portrait}=await fixture();stubModel(t,{beforeReview:()=>memory.remember("alice","用户现在更喜欢长回复","preference",4)});
  await assert.rejects(()=>portrait.refreshUserPortrait("alice"),(error:unknown)=>(error as {status:number}).status===409);
  assert.equal(db.one("SELECT count(*) AS n FROM user_portraits")?.n,0);
});

test("deleting a current nickname also clears stale pointers and derived portrait without reviving an old nickname",async(t)=>{
  const {db,memory,portrait}=await fixture();
  memory.remember("alice","旧称呼","address",4);const current=memory.remember("alice","新称呼","address",4);
  stubModel(t);await portrait.refreshUserPortrait("alice");
  assert.equal(memory.forget("bob",current),false);assert.equal(db.one("SELECT count(*) AS n FROM user_portraits")?.n,1);
  assert.equal(memory.forget("alice",current),true);assert.equal(db.one("SELECT count(*) AS n FROM user_portraits")?.n,0);
  assert.equal(db.one("SELECT count(*) AS n FROM memories WHERE user_id='alice' AND kind='address' AND status='active'")?.n,0);
  assert.equal(db.rows("PRAGMA foreign_key_check").length,0);
});

test("clearing chat removes its derived portrait but keeps confirmed long-term memories",async(t)=>{
  const {db,portrait}=await fixture();const history=await import("../packages/core/src/conversation/history");history.touchConversation("alice");
  stubModel(t);await portrait.refreshUserPortrait("alice");history.eraseConversation("alice",false);
  assert.equal(db.one("SELECT count(*) AS n FROM user_portraits")?.n,0);
  assert.equal(db.one("SELECT count(*) AS n FROM memories WHERE user_id='alice'")?.n,1);
});

test("overview and generation require administrator authentication, and empty or unconfigured generation does not fake a summary",async()=>{
  const {db,portrait}=await fixture();const {handle}=await import("@gateway");
  assert.equal((await handle(new Request("http://localhost/api/memory/overview?user_id=alice"),["memory","overview"])).status,401);
  const response=await handle(new Request("http://localhost/api/memory/overview?user_id=alice",{headers:{Authorization:"Bearer portrait-admin"}}),["memory","overview"]);
  assert.equal(response.status,200);assert.equal((await response.json()).user.id,"alice");
  process.env.DEEPSEEK_API_KEY="";await assert.rejects(()=>portrait.refreshUserPortrait("alice"),(error:unknown)=>(error as {status:number}).status===503);
  (await import("@people/users")).getOrCreateUser("empty","没有聊天");await assert.rejects(()=>portrait.refreshUserPortrait("empty"),/没有可供总结/u);
  assert.equal(db.one("SELECT count(*) AS n FROM user_portraits")?.n,0);
});

test("automatic portraits wait for enough new messages, debounce per owner and stop using deleted historical evidence",async(t)=>{
  const {db,now,portrait,memory}=await fixture();const {scheduleUserPortrait}=await import("../packages/memory/src/portrait-jobs");
  const job=scheduleUserPortrait("alice");assert.ok(job);assert.equal(scheduleUserPortrait("alice"),null);
  assert.equal(portrait.userMemoryOverview("alice").stats.portrait_pending,true);
  stubModel(t);await portrait.refreshUserPortrait("alice");assert.equal(db.one("SELECT status FROM jobs WHERE id=?",job)?.status,"completed");
  assert.equal(scheduleUserPortrait("alice"),null);
  for(let index=0;index<3;index++)db.run("INSERT INTO messages(user_id,channel,role,content,created_at) VALUES('alice','web','user',?,?)",`新的聊天${index}`,now);
  assert.ok(scheduleUserPortrait("alice"));
  const id=Number(db.one("SELECT id FROM memories WHERE user_id='alice'")!.id);memory.forget("alice",id);
  assert.equal(portrait.portraitInputAvailable("alice"),false);
  assert.equal(scheduleUserPortrait("alice"),null);
  await assert.rejects(()=>portrait.refreshUserPortrait("alice"),/没有可供总结/u);
});

test("memory extraction uses only the same owner's channel context to understand short answers",async(t)=>{
  const {db,now,memory}=await fixture();
  db.run("INSERT INTO messages(user_id,channel,role,content,created_at) VALUES('alice','web','assistant','我叫林知夏，你叫什么？',?)",now);
  const current=db.run("INSERT INTO messages(user_id,channel,role,content,created_at) VALUES('alice','web','user','阿舟',?)",now).lastId;
  db.run("INSERT INTO messages(user_id,channel,role,content,created_at) VALUES('alice','qq','user','其他渠道隔离标记',?)",now);
  const requests:string[]=[];
  t.mock.method(globalThis,"fetch",async(_input:unknown,init?:RequestInit)=>{
    const body=JSON.parse(String(init?.body));const data=JSON.parse(String(body.messages.at(-1).content));requests.push(JSON.stringify(data));
    const output=data.latest_user_message.content==="阿舟"?[{text:"用户姓名是阿舟",kind:"name",confidence:0.95,sensitive:false}]:[];
    return Response.json({choices:[{message:{content:JSON.stringify(output)},finish_reason:"stop"}],usage:{prompt_tokens:5,completion_tokens:5}});
  });
  await memory.extractUnprocessedWithModel(2,"alice");
  assert.equal(requests.length,2);assert.ok(requests[1].includes("你叫什么"));assert.doesNotMatch(requests.join("\n"),/另一用户|其他渠道隔离标记/u);
  assert.equal(db.one("SELECT source_message_id FROM memory_candidates WHERE user_id='alice'")?.source_message_id,current);
  memory.processPending();assert.ok(memory.listMemories("alice").some(item=>String(item.text).includes("阿舟")));
  const age=memory.remember("alice","用户23岁","age",4);const name=memory.remember("alice","用户姓名是阿舟","name",4);
  assert.notEqual(age,name);assert.equal(db.one("SELECT status FROM memories WHERE id=?",age)?.status,"active");
});
