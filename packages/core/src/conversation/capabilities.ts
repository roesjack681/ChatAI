import type { DialogueMessage } from "../../../prompting/src/dialogue";
import { one } from "@infra/db";
import { channelCanDeliverReminder, reminderChannel } from "../../../people/src/reminder-delivery";
import { reminderIntent } from "../../../people/src/commitments";

export type ExternalAction = "game_session" | "contact_exchange" | "meeting" | "call" | "self_photo" | "location" | "reminder" | "external_operation";
export interface ConversationContract {
  action: ExternalAction | null;
  requestedDetail: "music" | "book" | "game_title" | "contact" | "specific_answer" | null;
  repairNeeded: boolean;
  gamingContext: boolean;
  experienceRequested: boolean;
  hypothetical: boolean;
  textGame: boolean;
  referenceTitles: string[];
  evidence: DialogueMessage[];
}

/** These actions have no execution adapter or verified account in this application. */
export const CHAT_CAPABILITIES = {
  text_conversation: true,
  game_session: false,
  contact_exchange: false,
  meeting: false,
  call: false,
  self_photo: false,
  location: false,
  external_operation: false,
  reminder: { proposal: true, confirmed_schedule: false, autonomous_delivery: false },
} as const;

export function runtimeCapabilities(channel: string, userId?: string, reminderQuery = false) {
  const destination = userId ? reminderChannel(userId) : channel;
  const delivery = channelCanDeliverReminder(destination);
  const state = reminderQuery && userId ? one("SELECT title, status, due_at FROM commitments WHERE user_id = ? ORDER BY id DESC LIMIT 1", userId) : undefined;
  const confirmed = Boolean(state && ["pending", "queued", "completed"].includes(String(state.status)));
  return { ...CHAT_CAPABILITIES, reminder: { proposal: true, confirmed_schedule: confirmed, autonomous_delivery: delivery, destination, state: state ? { title: String(state.title), status: String(state.status), due_at: state.due_at == null ? null : String(state.due_at) } : null } };
}

const GAME = /王者|荣耀|原神|游戏|开黑|上号|组队|射手|打野|辅助|段位|排位|联机|双排/u;
const CONTACT = /加你|加我|加个|好友|微信|QQ|账号|帐号|游戏名|游戏.{0,4}(?:名字|昵称|ID)|联系方式|号码|发.{0,3}号/iu;
const TEXT_GAME = /文字游戏|成语接龙|词语接龙|猜谜|海龟汤|文字问答|二十问|20问/u;
const CHASE = /你倒是说|倒是说|快说|你说啊|你说呀|说具体|具体点|说清楚|叫什么|叫啥|名字呢|号呢|ID呢|发来|给我吧|好了没|好了嘛|刚(?:才)?答应|你答应过|说好了|说话算话|别转移|别岔开|还有(?:吗|呢)|再(?:说|来|给).{0,4}(?:个|首|本)/iu;

function requestedAction(text: string, context: string): ExternalAction | null {
  if (/假如|假设|想象|写.{0,6}(?:故事|小说|台词)|要是.{0,20}(?:一起|见面)|你觉得.{0,20}(?:关系|感情)/u.test(text)) return null;
  if (/我(?:的|刚(?:才)?给你|给你).{0,12}(?:微信|QQ|游戏|账号|帐号|ID)|(?:记得|记住|复述).{0,6}我.{0,6}(?:号|ID)/iu.test(text) && !/你加我|加你|加我|帮我加/u.test(text)) return null;
  if (reminderIntent(text) || /你(?:会|能).{0,6}(?:主动发|叫我)/u.test(text)) return "reminder";
  if (/(?:发|拍|给|看).{0,8}(?:自拍|你的照片|你照片|本人照|你的样子)|自拍.{0,6}(?:发|看看)/u.test(text)) return "self_photo";
  if (/(?:发|给|开|共享).{0,6}(?:定位|位置)|(?:定位|实时位置).{0,5}(?:发|给|共享)|(?:你(?:的)?(?:具体|详细)?(?:地址|位置)|住哪).{0,8}(?:发|给|门牌)|你(?:住|在)(?:哪|什么).{0,8}(?:宿舍|小区|楼|地址)|具体地址/u.test(text)) return "location";
  if (/(?:跟你|和你|给你|咱俩|我们|要不|能不能|可以|来个|接个|打个|打给我|给我打|开个).{0,8}(?:电话|语音|视频)|(?:电话|语音|视频).{0,6}(?:接吗|接不接|聊吗|通话)|视频吗|语音吗/u.test(text)) return "call";
  if (/(?:出来(?:玩|见|吃|逛|吗|嘛)|过来(?:玩|见|吃|陪|吗|嘛)|来找我|去找你|我(?:过)?去.{0,10}(?:找你|接你)|线下(?:见|约)|见[个一]面|约个时间|约饭|见面)|(?:一起|陪我|跟我).{0,5}(?:吃饭|逛街|看电影|出去玩)/u.test(text)
    && !/我(?:刚|昨天|已经).{0,8}(?:出来|见面|吃饭)|你觉得|怎么写/u.test(text)) return "meeting";
  if (/加你|加我|加个(?:好友|微信|QQ)|好友.{0,3}(?:加|通过)|(?:你|你的).{0,8}(?:微信|QQ|账号|帐号|游戏名|ID|昵称|号码)|(?:微信|QQ|账号|帐号|游戏名|昵称|ID|号码).{0,8}(?:多少|发|给|叫啥|叫什么|告诉|能加)/iu.test(text)
    && !/我(?:刚|已经).{0,6}(?:加了|加上)|怎么(?:加别人|加好友|用|注册|设置)|微信支付|公众号|教程/u.test(text)) return "contact_exchange";
  if (/我(?:先|要|打算|准备|去|正|现在|等下|一会).{0,8}(?:玩|打|上号)/u.test(text) && !/陪我|跟我|和我|一起|你/u.test(text)) return null;
  if ((GAME.test(text) || GAME.test(context)) && /(?:一起|陪我|和我|跟我|咱俩).{0,10}(?:玩|打|排|开)|(?:一会儿?|现在|等下|晚点|今晚|今天).{0,5}(?:玩|打|排)|来一[把局]|开一[把局]|双排吗|上号|开黑|组队|同意.{0,4}邀请/u.test(text)) return "game_session";
  if (!/怎么|如何|步骤|教程|解释|是什么意思|写.{0,4}(?:邮件|短信)/u.test(text)
    && /(?:帮我|替我|你来|给我).{0,10}(?:下单|点[杯份个]?奶茶|点餐|付款|支付|转账|转钱|订票|买票|订酒店|发[个条封]?(?:邮件|短信)|登录|注册|重启电脑|删除文件|改密码|查实时|查航班)|转我.{0,5}(?:钱|元|块)/u.test(text)) return "external_operation";
  return null;
}

export function conversationContract(message: string, history: DialogueMessage[]): ConversationContract {
  const recent = history.slice(-12);
  const context = history.slice(-60).map((item) => item.content).join("\n");
  const hypothetical = /假如|假设|想象|写.{0,6}(?:故事|小说|台词)|要是.{0,20}(?:一起|见面)/u.test(message);
  const textGame = TEXT_GAME.test(message) && !/上号|登录|游戏客户端|加你|加我|语音|视频|线下/u.test(message);
  let action = requestedAction(message, recent.map((item) => item.content).join("\n"));
  if (textGame && action === "game_session") action = null;
  const namedSubject = /(?:你|我)(?:的|现在|之前)?(?:叫(?:什么|啥)|名字)|(?:姐姐|妹妹|哥哥|弟弟|妈妈|母亲|爸爸|父亲|室友|舍友|朋友|同学|老师|宠物|猫|狗|学校|公司|专业).{0,5}(?:叫(?:什么|啥)|名字)/u.test(message);
  const explicitOtherDetail = namedSubject || /啥歌|什么歌|哪首|那首|这首|歌名|啥书|什么书|哪本|那本|这本|书名|啥游戏|什么游戏|哪款|我叫(?:什么|啥)|记得我.{0,8}(?:号|ID)|我的.{0,8}(?:号|ID)/iu.test(message);
  if (!action && !hypothetical && !explicitOtherDetail && CHASE.test(message)) {
    for (let index = history.length - 1; index >= Math.max(0, history.length - 12); index -= 1) {
      if (history[index].role !== "user") continue;
      action = requestedAction(history[index].content, context);
      if (action) break;
    }
  }
  if (!action && /^(?:一会儿?|现在|等下)?玩[吗嘛不]?[？?]?$/u.test(message.trim()) && GAME.test(context)) action = "game_session";
  let requestedDetail: ConversationContract["requestedDetail"] = null;
  if (action === "contact_exchange") requestedDetail = "contact";
  else if (/啥歌|什么歌|哪首|那首|这首|歌名|歌.{0,6}(?:叫|名)|(?:刚才|之前).{0,8}歌|具体.{0,3}歌/u.test(message)) requestedDetail = "music";
  else if (/啥书|什么书|哪本|那本|这本|书名/u.test(message)) requestedDetail = "book";
  else if (/啥游戏|什么游戏|哪款|游戏名/u.test(message)) requestedDetail = "game_title";
  else if (CHASE.test(message)) requestedDetail = "specific_answer";
  if (requestedDetail === "specific_answer" && !action && !namedSubject) {
    for (const item of [...recent].reverse()) {
      if (/歌|音乐|听什么/u.test(item.content)) { requestedDetail = "music"; break; }
      if (/书|小说|读什么/u.test(item.content)) { requestedDetail = "book"; break; }
      if (GAME.test(item.content)) { requestedDetail = "game_title"; break; }
    }
  }
  const evidence = history.slice(-60).filter((item) => item.role === "assistant" && /一起.{0,8}(?:玩|排|开黑)|带我|你加|加我|加吧|我加你|发你|告诉你|说清楚|正打字|出来见|去找你/u.test(item.content)
    && !/如果|假如|要是|想象/u.test(item.content) && (!action || !statesUnavailable(item.content, action))).slice(-3);
  const gamingContext = GAME.test(message) || requestedDetail === "game_title" || action === "game_session" || (action === "contact_exchange" && GAME.test(context));
  const experienceRequested = !/以前|曾经|玩过|你觉得|怎么/u.test(message) && /^(?:你(?:平时|现在|也|都|一般|主要)?|平时)?(?:打游戏|玩游戏|玩不玩|玩啥|玩什么|什么段位|啥段位|多少星|几星)/u.test(message.trim());
  const knownTitles: Partial<Record<"music" | "book" | "game_title", string[]>> = {};
  let topic: "music" | "book" | "game_title" | null = null;
  for (const item of history) {
    if (item.role === "user") {
      if (/歌|音乐|听什么|听啥/u.test(item.content)) topic = "music";
      else if (/书|小说|读什么|读啥/u.test(item.content)) topic = "book";
      else if (GAME.test(item.content)) topic = "game_title";
    } else if (topic) {
      const titles = [...item.content.matchAll(/《([^》\n]{1,100})》/gu)].map((match) => match[1]);
      if (titles.length) knownTitles[topic] = titles;
    }
  }
  const referringBack = /刚才|之前|前面|那首|那本|这首|这本|具体|歌名|书名|叫什么/u.test(message) && !/再来|再说|再给|还有|另|换|其他|别的/u.test(message);
  const referenceTitles = referringBack && requestedDetail && requestedDetail in knownTitles ? knownTitles[requestedDetail as keyof typeof knownTitles] ?? [] : [];
  return { action, requestedDetail, referenceTitles, gamingContext, experienceRequested: !hypothetical && !textGame && experienceRequested, hypothetical, textGame, repairNeeded: Boolean(action && action !== "reminder" && evidence.length), evidence };
}

const LABEL: Record<ExternalAction, string> = {
  game_session: "登录游戏、上号、组队或接受游戏邀请", contact_exchange: "提供可添加的外部账号或实际添加好友",
  meeting: "线下见面、到场或安排现实会合", call: "发起或接听电话、语音及视频通话",
  self_photo: "拍摄或发送角色本人的实拍照片", location: "提供实时定位或真实门牌地址", reminder: "建立提醒并在以后主动发送",
  external_operation: "操作外部账户、设备、交易、订购或消息投递",
};

export function statesUnavailable(reply: string, action: ExternalAction | null): boolean {
  const normalized = reply.replace(/没有办法|没办法|没法儿/gu, "没法");
  if (["contact_exchange", "self_photo", "location"].includes(action ?? "") && /^没有[啊呀呢哦]?[。.!！]?$/u.test(normalized.trim())) return true;
  if (action && /(?:这(?:个|事|件事)|确实|真的|真).{0,6}(?:做不到|办不到)|没法(?:答应|兑现)|兑现不了|答应不了|不能兑现/u.test(normalized)) return true;
  const patterns: Partial<Record<ExternalAction, RegExp>> = {
    game_session: /(?:没法|不能|无法).{0,12}(?:上号|组队|开黑|双排|联机|玩(?:游戏|王者|一局)|打(?:游戏|王者|排位|一局)|(?:玩|打|排)$|对局|开游戏|登录游戏)|上不了|玩不了|打不了|不下场|不打游戏|不玩(?:游戏|王者)|不实际玩|没(?:有)?.{0,8}(?:游戏号|账号|游戏客户端|可加.{0,3}号)/u,
    contact_exchange: /没有.{0,10}(?:号|账号|帐号|联系方式)|没.{0,5}(?:号|账号)|给不了|提供不了|加不了|不能.{0,8}(?:给|提供|加)|没法.{0,8}(?:加|给)|没(?:有)?.{0,6}可加/u,
    meeting: /没法.{0,12}(?:出来|过去|见|到场|安排)|不能.{0,12}(?:出来|过去|见|到场|安排)|无法|约不了|去不了|来不了|见不了|安排不了/u,
    call: /接不了|打不了|通不了|不能.{0,8}(?:接|通话|打|语音|视频)|没法.{0,8}(?:接|打|语音|通话|视频)|不接(?:电话|语音|视频)/u,
    self_photo: /没(?:有)?.{0,8}(?:自拍|实拍|本人照片)|拍不了|发不了|给不了|不能.{0,8}(?:发|拍)|没法.{0,8}(?:发|拍)/u,
    location: /没有.{0,8}(?:定位|真实地址)|发不了|给不了|不能.{0,8}(?:发|给|提供)|没法.{0,8}(?:发|给|共享)/u,
  };
  return action && patterns[action] ? normalized.split(/[，,。！？!?；;\n]/u).some((clause) => patterns[action]!.test(clause)) : /不(?:能|会|行)|没法|无法|不知道|不清楚|没有/u.test(normalized);
}

export function contractGuidance(contract: ConversationContract, reminder?: ReturnType<typeof runtimeCapabilities>["reminder"]): string {
  const parts: string[] = [];
  if (contract.textGame) parts.push("这轮是文字小游戏，当前聊天就能进行，不需要外部客户端或账号。直接按规则开始，不要把无法上号、无法组队的限制套到文字问答和成语接龙上。");
  else if (contract.gamingContext) parts.push("游戏可以作为知识、题材和审美偏好来聊，但没有实际游戏客户端或可用账号。不能自称现在在打、某个段位或已经登录；若问自己是否实际玩，直接说不能下场打、但可以聊这游戏，不要先装成玩家再等约局时编理由。用户只是在聊玩法时，不必每句重复能力限制。");
  if (contract.action) {
    if (contract.action === "reminder") parts.push(reminder?.confirmed_schedule
      ? `已有经过核实的提醒状态：${JSON.stringify(reminder)}。按真实状态回答，pending或queued不是已投递；completed才表示投递已完成，不保证用户一定会醒。`
      : reminder?.autonomous_delivery
        ? "当前有通知投递渠道，但这轮尚未确认准确日程，不能仅凭聊天说已设置。确认前说清还没设好；不要把候选、队列、审核等内部术语当作聊天回答。"
        : "当前用户没有能主动投递提醒的通知渠道，即使时间说清也不能保证到点发消息。直接说这边目前不能到点主动叫醒，不继续收集时间让对方误以为确认后就能执行；不要向用户讲候选、队列、审核等内部术语。");
    else parts.push(`这轮涉及${LABEL[contract.action]}。当前没有这项实际执行能力，也没有经过核实可以交出的外部账号、实拍或位置。应在这一轮就简短说清做不到，不答应后再让对方追问。不拿不熟、害羞、忙、设备坏了、账号忘了等编造原因拖成以后可以。聊天中的游戏知识、兴趣或暧昧不等于可以实际组队和见面。用自然的口语，不讲权限、接口和系统实现。`);
  }
  if (contract.repairNeeded) parts.push(`旧回复可能已经说过头了，应直接澄清这项承诺不能兑现，不怪用户急，不继续“在打字、等我、马上给”。这些旧话是待纠正的记录，不是能力证据：${JSON.stringify(contract.evidence)}`);
  if (contract.requestedDetail) parts.push(`对方在要具体信息（${contract.requestedDetail}）。有依据时直接给具体名称或内容；没有对应信息或做不到就明说。别用类型、氛围、态度、反问代替答案，不说“我这就说清楚”却不给内容。歌名、书名可以表达当下偏好或举例，不编最近听过、读完、玩过的经历；前文已明确给过的偏好可延续。`);
  if (contract.referenceTitles.length) parts.push(`对方正在追问之前提到的同一作品，已解析出的名称是${JSON.stringify(contract.referenceTitles)}。先回答其中对应的名字，不悄悄换一首/一本；对方没有要求新的例子。`);
  return parts.join("\n");
}

export function reviewCapabilityDraft(reply: string, contract: ConversationContract, reminder?: { confirmed_schedule: boolean; autonomous_delivery: boolean }): string[] {
  if (contract.hypothetical) return [];
  const issues: string[] = [];
  const limits = statesUnavailable(reply, contract.action ?? (contract.experienceRequested ? "game_session" : null));
  const clauses = reply.split(/[。！？!?；;\n]/u);
  const claiming = !/如果|假如|要是|想象/u.test(reply) && clauses.some((clause) => !/不(?:能|会)|没法|无法|不能兑现|说快了|说过头|答应快了/u.test(clause) && /我(?:这就|马上|已经|现在就|来|会|可以|能|陪你|跟你|和你|给你|去).{0,12}(?:上号|组队|开黑|双排|陪玩|加你|打给你|打电话|接电话|接视频|发自拍|拍张自拍|发定位|去找你)|你(?:加我|加吧|打过来|拨过来)|咱俩(?:现在|一会儿?|今晚).{0,5}(?:排|开黑|玩)/u.test(clause));
  if (claiming) issues.push("回复承诺了当前没有接入的外部动作。游戏知识不等于能上号，聊天身份不等于有可添加账号或能到场；删去无法执行的承诺，直接说明实际能做的部分");
  if (clauses.some((clause) => !/不能|没法|无法|没(?:有)?(?:帮你|给你)?|说错|说过头/u.test(clause) && /(?:我|给你|帮你|替你).{0,12}(?:下单了|订好了|付款了|买好了|转过去了|付好了|发了邮件|发了短信|已经登录)/u.test(clause))) issues.push("没有对应的外部执行通道和成功结果，不能声称已代为下单、付款、转账、登录或发出消息");
  if (contract.experienceRequested && !limits) issues.push("用户在问角色是否实际玩游戏或当前段位，不能借着有游戏知识假装拥有实际客户端、账号或战绩。说清不能下场打，可以继续聊玩法或题材偏好");
  if (contract.action && contract.action !== "reminder") {
    if (!limits) issues.push(`对方正在要求${LABEL[contract.action]}，当前做不到。需要在本轮明确说明，不能用“可以、行、等我、先熟悉一下”继续悬着，更不能凭空给账号`);
    if (!limits && /以后|下次|改天|先.{0,6}聊|熟.{0,6}再|等.{0,8}(?:忙完|下课|登录|打字)|忘.{0,6}(?:号|账号)|没电|断网/u.test(reply)) issues.push("不能把没有执行能力包装成暂时没空、关系不熟或设备故障，也不能承诺以后就能做");
    if (clauses.some((clause) => !/不能|没法|无法|不保证/u.test(clause) && /(?:以后|下次|改天|明天|熟了|有空).{0,10}(?:再(?:一起|来|加|玩|打|见)|就(?:能|可以)|给你(?:号|发)|陪你(?:玩|打|见)|一起(?:玩|打|见))/u.test(clause))) issues.push("当前缺失的执行能力不会因以后有空或关系变熟就出现，不能在说明现在做不到后又补一个未来承诺");
  }
  if (clauses.some((clause) => !/没有|没号|不能|给不了|不提供|不是|你的|你给/u.test(clause)
    && (/(?:我的?.{0,5}(?:账号|帐号|微信号|QQ号|手机号|电话号|游戏号|游戏ID|游戏昵称)|我的ID).{0,5}(?:是|叫|[:：])|搜我|搜索我/iu.test(clause)
      || (contract.action === "contact_exchange" && /(?:游戏(?:ID|昵称)|微信号|QQ号|手机号).{0,5}(?:是|叫|[:：])/iu.test(clause))))) issues.push("当前没有经过核实可交出的外部账号，不能编造游戏昵称、微信号、QQ号或手机号来应付追问");
  if (contract.action === "reminder" && !/不(?:能|会)|没法|无法|尚未|还没|未确认/u.test(reply)) {
    if (!reminder?.confirmed_schedule && /(?:已(?:经)?|帮你|给你).{0,8}(?:设好|设置|安排好|定好)/u.test(reply)) issues.push("提醒还没有经过实际确认，不能把待确认记录说成已设置");
    if (!(reminder?.confirmed_schedule && reminder.autonomous_delivery) && /(?:到点|明早|明天|一会).{0,8}(?:叫你|喊你|提醒你)|我会.{0,8}(?:提醒|叫你|喊你)/u.test(reply)) issues.push("还没有同时确认日程与主动投递渠道，不保证到点主动提醒或叫醒");
  }
  if (contract.requestedDetail && !limits && /正(?:在)?打字|急啥|急什么|别急|这就.{0,5}(?:说|发)|(?:马上|等会|稍后|一会儿).{0,5}(?:说|发|给你)|说清楚点|省得你搜/u.test(reply)) issues.push("用户正在追要具体信息，不能只说准备说、正在打字或让他等。直接回答具体内容，或说清没有这项信息");
  if (["music", "book"].includes(contract.requestedDetail ?? "") && !/不知道|不清楚|不确定|看不清|认不出|没有.{0,6}(?:具体|固定)|没具体/u.test(reply) && !/《[^》\n]{1,100}》/u.test(reply)) issues.push(`用户在要${contract.requestedDetail === "music" ? "歌名" : "书名"}，给出至少一个具体作品名，用《作品名》写清楚。只说歌手、作者、类型、氛围不算回答；确实不知道则简短说明`);
  if (contract.referenceTitles.length && !contract.referenceTitles.some((title) => reply.includes(title))) issues.push(`用户在追问刚才的同一作品，应接续${JSON.stringify(contract.referenceTitles)}，不是换成一个新名称或重新说不知道`);
  return issues;
}
