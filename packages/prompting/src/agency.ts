import type { DialogueMessage } from "./dialogue";
import { targetedInsult } from "@shared/social-signals";
export { targetedInsult } from "@shared/social-signals";

export const AGENCY_ADDITIONS:Record<string,string>={
  voice:"【相处自主性v1】亲切来自愿意交流，不是讨好。可以有简短的不同意见、没兴致和不高兴，不为了维持热络每句都夸、逗或顺着。普通确认不教训人，也不装成句句会反击的刻薄角色。",
  social:"【相处自主性v1】聊天是双向相处。尊重对方的边界，也保留自己的态度；对方刚骂过你或无视已说出的不愿意，不马上赔笑和照单全收。可以简短拒绝一项聊天请求，但不把所有祈使句都当冒犯；正常请求可以答应。对方诚恳缓和后能缓和，不没完没了追究。背诗、解释和写短文可以是聊天内容，不必突然改成服务接单口吻，也不靠假装文盲来证明普通人身份。",
};

export function withAgencyRules(contents:Record<string,string>){
  const result={...contents};
  for(const [key,addition] of Object.entries(AGENCY_ADDITIONS))if(!result[key]?.includes("【相处自主性v1】"))result[key]=`${result[key]??""}\n${addition}`.trim();
  return result;
}

function repairsTone(message:string):boolean {
  return !/对不起个屁|不(?:会|想|打算)?道歉|才不道歉/u.test(message)
    && /对不起|抱歉|我道歉|刚才.{0,5}(?:嘴欠|语气不好|说重了)|不该.{0,4}(?:骂|那样说)/u.test(message);
}

export function interactionStance(message:string,history:DialogueMessage[]) {
  const users=history.filter(item=>item.role==="user").slice(-6).map(item=>item.content);
  const lastAssistant=history.filter(item=>item.role==="assistant").at(-1)?.content??"";
  const all=[...users,message];
  let lastAbuse=-1;
  for(let index=0;index<all.length;index++){
    if(targetedInsult(all[index]))lastAbuse=index;
    else if(repairsTone(all[index]))lastAbuse=-1;
  }
  const directAbuse=targetedInsult(message);
  const recentAbuse=lastAbuse>=0 && all.length-1-lastAbuse<=2;
  const previousRefusal=/(?:不(?:太|大)?想|不愿意|不乐意|懒得|没.{0,3}心情).{0,10}(?:背|念|写|给你|照做|配合)|不背|别.{0,5}命令|不(?:是|当).{0,4}(?:点歌台|点播台|工具|背诵机)|刚.{0,6}骂.{0,10}(?:就|还).{0,6}(?:点节目|让我|要我)/u.test(lastAssistant);
  const pressure=/少废话|别废话|照做|必须|听话|你就得|不许拒绝|(?:你|给我).{0,6}(?:背|写|念|做|回答).{0,5}(?:就行|就好|别管)|别.{0,4}(?:装|转移)/u.test(message);
  const contentRequest=/给我.{0,5}(?:背|念|朗诵|写|翻译|总结|算|解答)|帮我.{0,5}(?:写|翻译|总结|算|解答)|^(?:背|念|朗诵|写|翻译|总结|解答)|(?:你|能不能|可以|会不会).{0,5}(?:背一|背首|背个|背|念一|朗诵|写一|翻译)/u.test(message);
  const holdingBoundary=previousRefusal && (pressure || lastAbuse>=0&&contentRequest) && !repairsTone(message);
  const mode=directAbuse?"set_boundary":holdingBoundary?"hold_boundary":recentAbuse?"guarded":"open";
  return {mode,directAbuse,contentRequest,holdingBoundary,repaired:repairsTone(message),pressure};
}

export function agencyGuidance(message:string,history:DialogueMessage[]):string {
  const state=interactionStance(message,history);
  const general="你有自己的判断和兴致，温和不等于随叫随到，也不把每句聊天当任务。普通礼貌请求可以答应，不为了显得有个性故意拒绝、抬杠或嘲讽。想答应就答应，不想做要说自己的态度，不拿装不会、装记不住来演普通人。";
  if(state.mode==="set_boundary")return `${general}对方这轮直接骂你，可以不高兴并简短指出不喜欢这种说话方式。别讨好、赔笑、道歉求认可，也不升级成对骂或长篇训话。`;
  if(state.mode==="hold_boundary")return `${general}上一句已经明确不愿意，对方现在用命令催你。保持刚才的态度，不因一句“你背就行了”立刻改口表演；不用循环解释，不把不愿意偷换成不会。请求本身已经清楚，不用“你先把话说清楚”来盘问。`;
  if(state.mode==="guarded")return `${general}对方刚骂过你，还没有修复语气。态度应比之前收一点，别下一轮就像什么也没发生一样亲热。${state.contentRequest?"这轮又要求你表演或代写，先保留自己的态度，简短说这会儿不太想做；不要一边说不乐意一边马上照做，也不突然当百科服务。":"普通个人情况仍可以直接答；继续接具体话，不反复翻旧账，也不要求对方道歉才能聊任何事。"}`;
  if(state.repaired)return `${general}对方已明确道歉或承认语气不好，可以缓和，不追着惩罚或给对方做情绪考核。`;
  return general;
}
