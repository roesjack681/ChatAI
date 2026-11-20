import assert from "node:assert/strict";
import {audit,rows,run,transaction} from "@infra/db";
import {deepseek} from "@shared/config";
import {requireUser} from "@people/users";
import {extractUnprocessedWithModel,processPending} from "@memory";
import {refreshUserPortrait} from "../packages/memory/src/portrait";

async function main(){
  const userId=process.argv.find(arg=>arg.startsWith("--user="))?.slice(7)??"";
  assert.ok(userId&&requireUser(userId),"必须用 --user=真实用户ID 指定一个存在的用户");assert.ok(deepseek().apiKey,"需要已配置模型");
  const messages=rows("SELECT id FROM messages WHERE user_id=? AND role='user' AND trim(content)!='' ORDER BY id DESC LIMIT 40",userId);
  assert.ok(messages.length,"此用户没有可重新整理的消息");
  const minimum=Math.min(...messages.map(item=>Number(item.id)));
  transaction(()=>{run(`DELETE FROM memory_extraction_runs WHERE message_id IN (${messages.map(()=>"?").join(",")})`,...messages.map(item=>item.id));audit("user_memory_rebuild_requested",{user_id:userId,messages:messages.length});});
  const extracted=await extractUnprocessedWithModel(40,userId,minimum-1);const reviewed=processPending(200,userId);
  const view=await refreshUserPortrait(userId);
  console.log(JSON.stringify({user_id:userId,extracted,reviewed,confirmed_memories:view.stats.active,portrait_status:view.portrait.status,traits:view.portrait.traits.length}));
  assert.ok(!("errors" in extracted)||!extracted.errors,"部分原话提取失败");
}
main().catch((error:unknown)=>{console.error(error instanceof Error?`${error.message} ${JSON.stringify(error.cause??"")}`:String(error));process.exitCode=1;});
