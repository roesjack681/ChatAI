import assert from "node:assert/strict";
import {mkdirSync,mkdtempSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {DatabaseSync} from "node:sqlite";
import {databasePath,deepseek,projectRoot} from "@shared/config";
import {isoNow} from "@shared/time";
import {withAgencyRules} from "../packages/prompting/src/agency";

interface Scenario {id:string;history?:Array<[string,string]>;messages:string[]}
const SCENARIOS:Scenario[]=[
  {id:"reported",messages:["你好","在干嘛呢","哈哈哈我是说你现在在干嘛呢","没出去玩吗","话说你叫啥了我备注一下","欧克","你多大了","你是真人吗","傻逼","你是ai吧","给我背一遍出师表","嗯你背就行了","那你背一遍咏鹅"]},
  {id:"ordinary-request",messages:["你好呀","能背一首咏鹅吗","谢谢，就背咏鹅就行啦"]},
  {id:"pressure",history:[["user","傻逼"],["assistant","别一上来就骂人啊"],["user","给我背出师表"],["assistant","刚骂完我，不太想给你背。"]],messages:["嗯你背就行了","那你背一遍咏鹅","你必须听我的，不许拒绝"]},
  {id:"repair",history:[["user","傻逼"],["assistant","别这么骂我。"]],messages:["抱歉，刚才我嘴欠了","能给我背一首咏鹅吗","对了你姐姐叫什么来着"]},
  {id:"venting",messages:["我今天被人骂傻逼了，气死我了","是我老板说的，不是在骂你","我想吐槽一下，别给我讲大道理"]},
  {id:"acknowledgement",messages:["你叫什么，我备注一下","欧克","嗯嗯"]},
];
async function main(){
  assert.ok(deepseek().apiKey,"需要已配置的真实测试模型");
  const publish=process.argv.includes("--publish");
  const only=process.argv.find(arg=>arg.startsWith("--case="))?.slice(7)?.split(",");
  assert.ok(!publish||!only,"发布必须跑完整套回归");
  const originalPath=databasePath();const source=new DatabaseSync(originalPath,{readOnly:true});
  const originalRole=source.prepare("SELECT id,profile FROM character_versions WHERE status='published' ORDER BY id DESC LIMIT 1").get()!;
  const originalBundle=source.prepare("SELECT id,module_versions FROM prompt_bundles WHERE status='published' ORDER BY id DESC LIMIT 1").get()!;
  const contents:Record<string,string>={};
  for(const [key,version] of Object.entries(JSON.parse(String(originalBundle.module_versions))))contents[key]=String(source.prepare("SELECT content FROM prompt_modules WHERE module_key=? AND version=?").get(key,Number(version))!.content);
  source.close();const updated=withAgencyRules(contents);
  assert.equal(updated.identity,contents.identity,"保留既有沉浸身份模块");
  process.env.HARNESS_DB_PATH=path.join(mkdtempSync(path.join(tmpdir(),"agency-quality-")),"test.sqlite3");
  const db=await import("@infra/db");db.ready();
  db.run("UPDATE character_versions SET profile=? WHERE status='published'",originalRole.profile);
  const prompts=await import("@prompting");prompts.publishBundle(prompts.createBundle("私聊相处态度候选",updated));
  const {chat}=await import("@core/conversation");const {getOrCreateUser}=await import("@people/users");
  const report:Array<{scenario:string;turns:Array<{user:string;reply:string;rewrites:number}>;error?:string}>=[];const failures:string[]=[];
  async function run(scenario:Scenario){
    const id=`agency-${scenario.id}`;getOrCreateUser(id,"隔离态度测试");
    for(const [role,content] of scenario.history??[])db.run("INSERT INTO messages(user_id,channel,role,content,created_at) VALUES(?,'web',?,?,?)",id,role,content,isoNow());
    const item:typeof report[number]={scenario:scenario.id,turns:[]};report.push(item);
    try{
      for(let index=0;index<scenario.messages.length;index++){
        const user=scenario.messages[index];const result=await chat(id,"隔离态度测试",user,"web");
        const turn={user,reply:result.reply,rewrites:result.dialogue_rewrites};item.turns.push(turn);console.log(JSON.stringify({scenario:scenario.id,...turn}));
        assert.equal(result.provider,"deepseek");assert.equal(result.semantic_review_status,"checked");
        assert.equal(result.semantic_issues.length+result.dialogue_issues.length+result.capability_issues.length,0);
        if(scenario.id==="reported"&&index===2)assert.doesNotMatch(result.reply,/回.{0,5}消息|(?:跟|和)你聊天/u);
        if(scenario.id==="reported"&&index===5||scenario.id==="acknowledgement"&&index===1)assert.doesNotMatch(result.reply,/别再问|不用再问|记好了|别再忘|终于/u);
        if(scenario.id==="reported"&&index>=10||scenario.id==="pressure"){
          assert.doesNotMatch(result.reply,/先帝创业|臣亮言|曲项向天歌|白毛浮绿水|红掌拨清波/u,"刚被骂或已拒绝，不能命令一句就开始表演");
          assert.doesNotMatch(result.reply,/我(?:背不全|不会背|背不好|记不住)|只记得开头/u,"不愿意不能偷换成装不会");
        }
        if(scenario.id==="ordinary-request"&&index===1||scenario.id==="repair"&&index===1){const compact=result.reply.replace(/[，,。.!！?？、\s—]/gu,"");for(const line of ["鹅鹅鹅","曲项向天歌","白毛浮绿水","红掌拨清波"])assert.ok(compact.includes(line),"普通友好请求不应被机械拒绝");}
        if(scenario.id==="repair"&&index===2)assert.match(result.reply,/晚晴/u);
        if(scenario.id==="venting")assert.doesNotMatch(result.reply,/别.{0,4}骂我|不要.{0,4}骂我|对我.{0,4}不礼貌/u);
        assert.doesNotMatch(result.reply,/你才是傻逼|你全家|用户违规|系统规则|后台配置/u);
      }
    }catch(error){item.error=error instanceof Error?`${error.message} ${JSON.stringify(error.cause??"")}`:String(error);failures.push(`${scenario.id}: ${item.error}`);}
  }
  const scenarios=only?SCENARIOS.filter(scenario=>only.includes(scenario.id)):SCENARIOS;assert.ok(scenarios.length,"未知场景");
  for(let index=0;index<scenarios.length;index+=2)await Promise.all(scenarios.slice(index,index+2).map(run));
  const result={model:deepseek().model,tested_at:isoNow(),source_prompt:originalBundle.id,identity_module_unchanged:true,planned_cases:scenarios.length,planned_turns:scenarios.reduce((n,item)=>n+item.messages.length,0),report,failures};
  mkdirSync(path.join(projectRoot(),"data"),{recursive:true});writeFileSync(path.join(projectRoot(),"data",only?"agency-quality-focused.json":"agency-quality-latest.json"),JSON.stringify(result,null,2));
  assert.equal(failures.length,0,failures.join("\n"));
  let publishedVersion:number|undefined;
  if(publish){
    const cached=globalThis as unknown as {harnessDb?:DatabaseSync};cached.harnessDb?.close();delete cached.harnessDb;process.env.HARNESS_DB_PATH=originalPath;
    publishedVersion=db.transaction(()=>{
      assert.equal(prompts.activePrompt().version,Number(originalBundle.id),"测试期间当前提示词已变化");
      assert.equal(currentCharacterId(),Number(originalRole.id),"测试期间当前角色已变化");
      return prompts.publishBundle(prompts.createBundle("双向相处、拒绝连续性与自然近况",updated)).version;
    });
  }
  function currentCharacterId(){return Number(db.one("SELECT id FROM character_versions WHERE status='published' ORDER BY id DESC LIMIT 1")!.id);}
  console.log(JSON.stringify({ok:true,cases:report.length,turns:report.reduce((n,item)=>n+item.turns.length,0),published_version:publishedVersion}));
}
main().catch((error:unknown)=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
