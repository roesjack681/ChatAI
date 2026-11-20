import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { projectRoot } from "@shared/config";
import { isoNow } from "@shared/time";

async function main(){
  const root=projectRoot();const port=18000;const url=`http://127.0.0.1:${port}`;
  const occupied=await fetch(`${url}/api/health`,{signal:AbortSignal.timeout(1500)}).then(()=>true).catch(()=>false);
  assert.equal(occupied,false,"生产检查端口已占用，未更改现有服务");
  const file=path.join(mkdtempSync(path.join(tmpdir(),"lingzhi-production-")),"production.sqlite3");
  const token=randomUUID()+randomUUID();const checks:unknown[]=[];let output="";let memoryUser="";
  for(let restart=0;restart<2;restart++){
    const child=spawn(process.execPath,["node_modules/next/dist/bin/next","start","apps/console","-p",String(port)],{cwd:root,windowsHide:true,env:{...process.env,NODE_ENV:"production",HARNESS_NEXT_DIST_DIR:".next-verify",HARNESS_DB_PATH:file,HARNESS_ADMIN_TOKEN:token},stdio:["ignore","pipe","pipe"]});
    const collect=(data:Buffer)=>{output=(output+data.toString()).slice(-8000);};child.stdout.on("data",collect);child.stderr.on("data",collect);
    try{
      let healthy=false;
      for(let attempt=0;attempt<40;attempt++){
        if(child.exitCode!=null)throw new Error("生产服务提前退出："+output);
        healthy=await fetch(`${url}/api/health`,{signal:AbortSignal.timeout(1000)}).then(response=>response.ok).catch(()=>false);
        if(healthy)break;await new Promise(resolve=>setTimeout(resolve,250));
      }
      assert.ok(healthy,"生产服务未就绪："+output);
      assert.equal((await fetch(`${url}/api/world/tree`)).status,401);
      const headers={Authorization:`Bearer ${token}`};
      const tree=await fetch(`${url}/api/world/tree`,{headers}).then(response=>response.json());
      assert.equal(tree.summary.npcs,5);assert.equal(tree.summary.experiences,9);assert.equal(tree.summary.relations,8);assert.equal(tree.summary.active_goals,3);assert.equal(tree.summary.schedules,13);
      const prompts=await fetch(`${url}/api/prompts`,{headers}).then(response=>response.json());
      assert.equal(Object.keys(prompts.active.modules).length,11);
      for(const key of ["voice","social"])assert.ok(prompts.active.moduleText[key].includes("【相处自主性v1】"),"新数据库缺少相处态度规则");
      for(const page of ["character","world","stories","npcs","prompts","memory","chat"])assert.equal((await fetch(`${url}/${page}`)).status,200);
      if(!memoryUser){const created=await fetch(`${url}/api/chat/conversations`,{method:"POST",headers:{...headers,"Content-Type":"application/json"},body:JSON.stringify({name:"生产记忆检查"})}).then(response=>response.json());memoryUser=created.conversation.id;}
      assert.equal((await fetch(`${url}/api/memory/overview?user_id=${encodeURIComponent(memoryUser)}`)).status,401);
      const memory=await fetch(`${url}/api/memory/overview?user_id=${encodeURIComponent(memoryUser)}`,{headers}).then(response=>response.json());
      assert.equal(memory.user.id,memoryUser);assert.equal(memory.stats.active,0);assert.equal(memory.portrait.status,"empty");
      checks.push({restart,summary:tree.summary,prompt_modules:11,unauthorized_status:401,pages:7,memory_overview:true});
    }finally{if(child.exitCode==null){child.kill();await once(child,"exit");}}
  }
  assert.deepEqual((checks[0] as any).summary,(checks[1] as any).summary,"重新启动改变了默认数据");
  const report={tested_at:isoNow(),production:true,isolated_database:true,checks,passed:true};
  mkdirSync(path.join(root,"data"),{recursive:true});writeFileSync(path.join(root,"data","production-smoke-latest.json"),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report));
}
main().catch((error:unknown)=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
