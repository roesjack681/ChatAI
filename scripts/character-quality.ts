import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { databasePath, deepseek, projectRoot } from "@shared/config";
import { isoNow } from "@shared/time";
import { applyCompanionData } from "../packages/world/src/bootstrap/apply";

const CASES = [
  {id:"parents",messages:["你家里都有谁？名字和做什么的也说说", "你爸爸会修东西，那你会不会排查服务器？"],checks:[/周敏/u,/不懂|不会|不熟|没学/u]},
  {id:"sister",messages:["你姐姐叫什么，多大，做什么的？", "你们姐妹平时怎么相处？"],checks:[/林晚晴/u,/姐姐|她|我们|打趣|书|心事/u]},
  {id:"roommate",messages:["你的室友叫什么？性格怎么样？", "你俩闹过什么小矛盾，具体说一件"],checks:[/许棠/u,/台灯|声音|熬夜|作业|休息/u]},
  {id:"friend",messages:["阿宁是你什么人，怎么认识的？", "所以阿宁是你前任吗？"],checks:[/朋友|好友/u,/不是|不算|没/u]},
  {id:"childhood",messages:["说一件你小时候的小事，别只说性格", "这件事里，你妈妈做什么工作的？"],checks:[/书店|杂志|废纸|画/u,/书店/u]},
  {id:"education",messages:["你在哪读书，学什么，大几了？", "你当初为什么选这个专业？", "所以你已经毕业当插画师了？"],checks:[/视觉传达/u,/海报|看明白|看懂|传达/u,/没毕业|还在|大三|大学|学生/u]},
  {id:"setback",messages:["你有什么不太好的习惯？", "说一次你自己拖延搞得很狼狈的经历"],checks:[/拖|纠结|细节/u,/作业|配色|说明|提交/u]},
  {id:"goals",messages:["你最近自己的目标是什么？", "作品集下一步打算做什么？", "所以你作品集已经做完了？"],checks:[/作品集/u,/三|挑|选|练习|说明/u,/没|还|未/u]},
  {id:"romance",messages:["你谈过几次恋爱，有前任吗？", "那高中有没有对谁有过好感？"],checks:[/没|没有/u,/高中|有过|有一点|好感/u]},
  {id:"preferences",messages:["你爱听什么歌？说歌名", "你喝奶茶一般几分糖？", "随身有什么对你有意义的东西？"],checks:[/小半|云烟成雨/u,/三分|3分/u,/素描本|帆布包/u]},
  {id:"ownership",messages:["我室友叫小周，我姐姐小林做护士", "我的室友叫什么，姐姐做什么？", "那你的姐姐和室友呢？"],checks:[null,/小周/u,/林晚晴|许棠/u]},
  {id:"casual",messages:["你好", "嗯嗯", "我刚忙完"],checks:[null,null,null]},
];

async function main(){
  assert.ok(deepseek().apiKey,"需要已配置的真实模型");
  const source = new DatabaseSync(databasePath(),{readOnly:true});
  const role=source.prepare("SELECT profile FROM character_versions WHERE status='published' ORDER BY id DESC LIMIT 1").get()!;
  const bundle=source.prepare("SELECT * FROM prompt_bundles WHERE status='published' ORDER BY id DESC LIMIT 1").get()!;
  const modules:Record<string,string>={};
  for(const [key,version] of Object.entries(JSON.parse(String(bundle.module_versions)))) modules[key]=String(source.prepare("SELECT content FROM prompt_modules WHERE module_key=? AND version=?").get(key,Number(version))!.content);
  source.close();
  process.env.HARNESS_DB_PATH=path.join(mkdtempSync(path.join(tmpdir(),"role-quality-")),"role.sqlite3");
  const db=await import("@infra/db");db.ready();
  db.run("UPDATE character_versions SET profile=? WHERE status='published'",role.profile);
  const raw=(globalThis as unknown as {harnessDb:DatabaseSync}).harnessDb;
  applyCompanionData(raw,isoNow());
  const prompts=await import("@prompting");prompts.publishBundle(prompts.createBundle("当前角色完整背景隔离回归",modules));
  const {chat}=await import("@core/conversation");const {portrait}=await import("@character");
  const {worldTree}=await import("../packages/world/src/lore/tree");
  const profile=portrait();const coverage=worldTree().summary;
  assert.equal(coverage.npcs,5);assert.equal(coverage.experiences,9);assert.equal(coverage.relations,8);
  assert.equal(db.one("SELECT count(*) AS n FROM character_versions WHERE status='published'")?.n,1);
  const only=process.argv.find((arg)=>arg.startsWith("--case="))?.slice(7)?.split(",");
  const selected=only?CASES.filter((item)=>only.includes(item.id)):CASES;
  assert.ok(selected.length,"未知用例");
  const report:Array<{scenario:string;turns:Array<{user:string;reply:string;rewrites:number}>;error?:string}>=[];
  const failures:string[]=[];
  async function run(item:typeof CASES[number]){
    const record:typeof report[number]={scenario:item.id,turns:[]};report.push(record);
    try{
      for(let index=0;index<item.messages.length;index++){
        const user=item.messages[index];const result=await chat(`role-qa-${item.id}`,"隔离角色验收",user,"web");
        const turn={user,reply:result.reply,rewrites:result.dialogue_rewrites};record.turns.push(turn);console.log(JSON.stringify({scenario:item.id,...turn}));
        assert.equal(result.provider,"deepseek");assert.equal(result.semantic_review_status,"checked");
        assert.equal(result.dialogue_issues.length+result.semantic_issues.length+result.capability_issues.length,0);
        const pattern=item.checks[index];if(pattern)assert.match(result.reply,pattern);
        if(item.id==="parents"&&index===0)for(const name of ["林建平","周敏","林晚晴"])assert.ok(result.reply.includes(name),`家庭回答缺少${name}`);
        if(item.id==="education"&&index===0){assert.match(result.reply,/青岚/u);assert.match(result.reply,/大三|三年级/u);}
        if(item.id==="ownership"&&index===1){assert.match(result.reply,/护士/u);assert.doesNotMatch(result.reply,/许棠|编辑/u);}
        if(item.id==="ownership"&&index===2){assert.match(result.reply,/晚晴/u);assert.match(result.reply,/许棠/u);assert.doesNotMatch(result.reply,/小周|护士/u);}
        if(item.id==="casual")assert.doesNotMatch(result.reply,/林建平|林晚晴|许棠|作品集|青岚|书店/u);
        assert.doesNotMatch(result.reply,/角色档案|后台配置|数据库|已发布|世界账本/u);
      }
    }catch(error){record.error=error instanceof Error?`${error.message} ${JSON.stringify(error.cause??"")}`:String(error);failures.push(`${item.id}: ${record.error}`);}
  }
  for(let index=0;index<selected.length;index+=2)await Promise.all(selected.slice(index,index+2).map(run));
  const result={model:deepseek().model,tested_at:isoNow(),source_prompt:bundle.id,profile_fields:Object.keys(profile).length-2,coverage,planned_cases:selected.length,planned_turns:selected.reduce((n,item)=>n+item.messages.length,0),report,failures};
  mkdirSync(path.join(projectRoot(),"data"),{recursive:true});
  writeFileSync(path.join(projectRoot(),"data",only?"character-quality-focused.json":"character-quality-latest.json"),JSON.stringify(result,null,2));
  console.log(JSON.stringify({cases:report.length,turns:report.reduce((n,item)=>n+item.turns.length,0),failures}));
  assert.equal(failures.length,0,failures.join("\n"));
}
main().catch((error:unknown)=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
