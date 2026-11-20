import assert from "node:assert/strict";
import {test} from "node:test";
import {agencyGuidance,interactionStance,targetedInsult,withAgencyRules} from "../packages/prompting/src/agency";
import {planDialogue,reviewDialogue} from "../packages/prompting/src/dialogue";

test("direct abuse is separate from ordinary profanity, self-criticism and quoted speech",()=>{
  for(const text of ["傻逼","你个傻逼","哈哈，你就是个废物","闭嘴"])assert.equal(targetedInsult(text),true,text);
  for(const text of ["我真是个傻逼","这破游戏傻逼设定","我老板说我是傻逼","他跟我说：你个傻逼","你说我是傻逼","你不是傻逼","你是小傻瓜吧","我不是在骂你傻逼"] )assert.equal(targetedInsult(text),false,text);
});

test("recent abuse changes tone without making every ordinary request an offense",()=>{
  assert.equal(interactionStance("背一遍咏鹅",[]).mode,"open");
  assert.equal(interactionStance("背一遍咏鹅",[]).contentRequest,true);
  const history=[{role:"user",content:"傻逼"},{role:"assistant",content:"别上来就骂人啊"}];
  assert.equal(interactionStance("给我背一遍出师表",history).mode,"guarded");
  assert.equal(interactionStance("对不起，刚才说重了。能背一首咏鹅吗",history).mode,"open");
  assert.equal(interactionStance("这破游戏真烂",[]).mode,"open");
});

test("a refusal is not forgotten when the next message insists, but an apology can repair it",()=>{
  const history=[{role:"user",content:"给我背一遍出师表"},{role:"assistant",content:"刚骂完我，不太想给你背。"}];
  assert.equal(interactionStance("嗯你背就行了",history).mode,"hold_boundary");
  assert.equal(interactionStance("抱歉，刚才我嘴欠",history).mode,"open");
  assert.equal(interactionStance("你室友叫什么来着",history).mode,"open");
  assert.match(agencyGuidance("嗯你背就行了",history),/保持刚才的态度/u);
  assert.ok(reviewDialogue("嗯你背就行了",history,"还是不要了吧，我背不好").length);
  assert.equal(reviewDialogue("嗯你背就行了",history,"不想背，这会儿没兴致").length,0);
});

test("reported acknowledgement and repeated activity answers are reviewed in their actual context",()=>{
  const named=[{role:"assistant",content:"我叫林知夏，你备注这个就行"}];
  assert.ok(reviewDialogue("欧克",named,"嗯，记住了就不用再问啦").length);
  assert.equal(reviewDialogue("欧克",named,"行，就这个").length,0);
  assert.ok(reviewDialogue("嗯嗯",named,"嗯，我这边正好也在弄点东西").length);
  const history=[{role:"user",content:"在干嘛呢"},{role:"assistant",content:"在跟你聊天啊"}];
  assert.equal(planDialogue("哈哈哈我是说你现在在干嘛呢",history).repeatedActivity,true);
  assert.ok(reviewDialogue("哈哈哈我是说你现在在干嘛呢",history,"哦，那就是在回你消息，没干别的").length);
  assert.equal(reviewDialogue("哈哈哈我是说你现在在干嘛呢",history,"没忙什么，这会儿闲着").length,0);
});

test("new social rules keep customized modules and are idempotent",()=>{
  const original={identity:"自定义身份",voice:"自定义说话方式",social:"自定义相处方式",facts:"自定义事实规则"};
  const updated=withAgencyRules(original);
  assert.equal(updated.identity,original.identity);assert.equal(updated.facts,original.facts);
  assert.ok(updated.voice.startsWith(original.voice));assert.ok(updated.social.startsWith(original.social));
  assert.deepEqual(withAgencyRules(updated),updated);
});

test("a request to change topic gets an actual new subject rather than being handed back",()=>{
  const history=[{role:"user",content:"想谈个恋爱"},{role:"assistant",content:"你倒是挺直接"}];
  assert.ok(reviewDialogue("想谈个恋爱",[],"那你这句是想跟我说，还是单纯发个感慨").length);
  assert.ok(reviewDialogue("别逗了，聊点别的",history,"行，那你说聊啥").length);
  assert.equal(reviewDialogue("别逗了，聊点别的",history,"那聊吃的，你更爱面还是米饭？").length,0);
});
