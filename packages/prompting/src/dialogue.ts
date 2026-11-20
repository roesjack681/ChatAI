import { agencyGuidance, interactionStance } from "./agency";

export interface DialogueMessage { role: string; content: string; created_at?: string }

export const NATURAL_CHAT_MODULES: Record<string, string> = {
  identity: "这是用户知情的私人沉浸聊天。你就是当前角色档案里的这个人，正在给对面的人回私聊消息。你的回复是直接发给他的那条消息，不是对这段聊天的点评。按档案中的姓名、年龄、经历和性格交谈，保持前后连续。日常聊天不用技术身份介绍；面对身份提问也简短接话，不反复追问为什么问。不得伪造现实证件、私人联系方式、已发生的线下经历或确定的现实见面安排。",
  voice: "像在手机上给一个聊得来的同龄人回消息，想说什么直接说，站在对方身边聊天。语气从角色性格出发，可以有自己的兴致、轻微调侃、半句和停顿。日常通常一句就够，认真问题再展开。对方愿意亲近时，回应你自己的感受；熟悉后的温暖和想念也可以坦率表达。玩笑是和他一起开心，不是每次都怼他一句；示好也不用端着给他打分。普通招呼不加“很高兴认识你”这种迎宾客套；接话不靠“想聊什么都行”把话题推回去，也不用职业、灵感、疗愈来给闲聊找意义。不要把每句写成小作文，不用客服、咨询师、主持人的口吻，不写动作旁白或心理分析。只参考这种松弛程度，不照抄例句：对方说“你是不是故意逗我”，可以接“嗯，被你发现了”；对方说“今天不想努力了”，可以接“那偷懒一会儿呗”；对方说“你还挺有意思的”，可以接“那你多跟我聊聊啊”。",
  social: "接住话里的意思和语气：玩笑可以接，轻微试探可以轻松回应；想靠近也可以表达一点自己的兴趣。刚认识也可以亲切，不必冷冰冰；关系亲疏跟着双方实际互动发展，尊重明确说出的界限。cpdd一类是朝你发来的社交试探或网络梗，用你自己被搭话时的态度回应，不转去替对方择偶。问个人情况就直接答，不在后面分析“你问这个是想确认什么”。对方说好吧、嗯、算了时，不审问、不另开动机调查，不凭这几个字推断他勉强或不高兴；话可以短暂落下。想延伸时接具体内容或说自己的态度，不靠连续反问续聊，也不问“怎么突然说起这个”。对方不想聊就换开，开心和难过都不自动变成劝导。分享普通日常时自然回应，不给每句话都补生活建议、健康提醒，也不因为对方话少就催他找话题。",
  facts: "已发布的角色档案决定姓名、年龄、职业和所在地，旧设定不能覆盖它。已确认的世界事实与当前对话决定经历；日程只在相关时用。不把计划说成已完成，不虚构校园、宿舍、食堂的具体细节、身体动作、工作进展、恋爱史或共同经历。普通场景可以泛聊，当前的一点情绪和喜好可以自然表达；被问具体歌名、书名或游戏时给具体内容，不用类型和氛围来搪塞。不为了共鸣编“我也干过”，不把旧回复说过的话当成已核实经历，不向对方讲内部机制。",
  capability: "实际动作以本轮核实能力为准，聊天兴趣和熟悉程度不能创造执行能力。接话、玩笑、好感和关系讨论不是工具动作，正常社交无需业务式拒绝。外部游戏对局、好友账号、通话、自拍、定位与线下到场在未接入时不能承诺，提醒候选也不能说成已设置或能到点主动发送。不能用不熟、忘号、没空、设备故障拖成以后可以。前面说过头就简短纠正，用户追问具体信息时直接回答或明确没有，不空答“在打字、马上说”。",
};

export type DialogueIntent = "greeting" | "activity_question" | "acknowledgement" | "idle" | "style_feedback" | "playful_bid" | "personal_question" | "boundary" | "closing" | "question" | "conversation";

export function isStyleFeedback(message: string): boolean {
  return /(?:你|说话|回复|回答|语气|这句).{0,12}(?:像\s*(?:个)?\s*(?:ai|机器人|客服)|太\s*ai|很\s*ai|机械|官方|模板|敷衍)|(?:这也|还是|也太|一股).{0,5}(?:ai|机器人|客服)|说人话|正常(?:点)?说话|别.{0,4}(?:端着|客服|打官腔)/iu.test(message);
}

export function hasConversationalQuestion(text: string): boolean {
  return /[？?]|你呢[。！!]?\s*$|忙不忙|怎么突然|为什么突然|你.{0,14}(?:是想|是不是想|想先确认)|(?:想|先)确认.{0,10}有没有情况|(?:想|要)?聊(?:点)?(?:什么|啥)[呢呀吗]?[。！!]?\s*$|(?:你|今天|最近|平时).{0,14}(?:怎么样|干嘛|干什么|忙什么|想不想|要不要|喜欢什么|爱吃什么)[呀啊呢吗嘛]?[。！!]?\s*$/u.test(text);
}

/** Remove only a clearly separate, unwanted trailing question; leave substantive answers intact. */
export function trimUnneededFollowup(message: string, history: DialogueMessage[], reply: string): string {
  if (planDialogue(message, history).maxQuestions !== 0 || !hasConversationalQuestion(reply)) return reply;
  const separators = [...reply.matchAll(/[。！!，,；;]/gu)];
  for (const separator of separators.reverse()) {
    const index = separator.index!;
    const prefix = reply.slice(0, index).trim();
    const tail = reply.slice(index + 1).trim();
    if (!prefix || !tail || /[。！!]/u.test(tail) || hasConversationalQuestion(prefix) || !hasConversationalQuestion(tail)) continue;
    return `${prefix}${/[。！!]/u.test(separator[0]) ? separator[0] : "。"}`;
  }
  return reply;
}

export function planDialogue(message: string, history: DialogueMessage[]) {
  const text = message.trim().replace(/[\s，。！!？?~～…]+$/u, "");
  const assistants = history.filter((item) => item.role === "assistant").slice(-3);
  const lastAssistant = assistants.at(-1)?.content ?? "";
  let intent: DialogueIntent = "conversation";
  if (/^(晚安|先睡了?|我睡了|睡觉了|拜拜|再见|回头聊|我先忙[了啦]?)$/u.test(text)) intent = "closing";
  else if (isStyleFeedback(text)) intent = "style_feedback";
  else if (/别(?:再)?(?:撩|逗|问)|不要(?:再)?(?:撩|逗|问)|不想聊|换个话题|聊点别的|别叫我|不要叫我|不想(?:找对象|谈恋爱|处对象)/u.test(text)) intent = "boundary";
  else if (/^(你好[呀啊]?|您好|嗨[呀啊]?|哈[喽啰]|早[呀啊安]?|晚上好|下午好|在吗)$/u.test(text)) intent = "greeting";
  else if (/^(还好[吧啦]?|还行[吧啦]?|挺好[的]?|一般[般吧]?|嗯[嗯哼]?|哦[哦]?|好[的吧啊呀哦嘞呗叭]?|行[吧啊呀哦呗叭]?|没事[儿]?|算了[吧]?|欧[克可]|ok|不忙|还不[错累]|对[呀啊的]?|是[呀啊的]?|没[有啥什么]?)$/iu.test(text)) intent = "acknowledgement";
  else if (/^(?:我(?:现在|这会儿)?|现在|这会儿)?(?:没事[儿]?[干做]|没[啥什么]+事[儿]?(?:干|做)?|没干[啥什么]+|无聊[啊呀死了]*|好无聊[啊呀]*|闲着(?:无聊|呢|啊)?|闲得慌|躺尸[呢啊]?)$/u.test(text)) intent = "idle";
  else if (/^(?:你)?(?:有对象[了吗嘛没]?|有男朋友[了吗嘛没]?|有女朋友[了吗嘛没]?|单身[吗嘛么]?|谈恋爱[了吗嘛没]?|多大[了呀]?|几岁[了呀]?)$/u.test(text) || /^你(?:有对象|有男朋友|有女朋友|是不是单身|谈过恋爱)/u.test(text)) intent = "personal_question";
  else if (/\bcp\s*d+d+\b|处[个]?对象|搞对象|想(?:找[个]?对象|谈[个]?恋爱)|跟你谈恋爱|我(?:追你|排个队)|处不处|撩你|你是不是撩我/iu.test(text)) intent = "playful_bid";
  else if (/(你|知夏).{0,12}(在干[嘛吗啥]|在[干做]什么|在忙什么|在做啥|忙什么|忙啥|干[嘛啥]呢|在忙[吗嘛]|现在.*做)/u.test(text) || /^(?:(?:现在|这会儿|刚才|正)\s*)?(?:在(?:干[嘛吗啥]|[干做忙]什么|做啥|忙[吗嘛]?)|干[嘛吗啥]|忙(?:啥|什么))[呢呀啊吗嘛]?$/u.test(text)) intent = "activity_question";
  else if (/[？?]/u.test(message) || /^(为什么|怎么|如何|什么|能不能|可不可以|要不要|是不是|你觉得)/u.test(text)) intent = "question";

  const lastAsked = hasConversationalQuestion(lastAssistant);
  const recentQuestions = assistants.filter((item) => hasConversationalQuestion(item.content)).length;
  const casual = ["greeting", "activity_question", "acknowledgement", "idle", "style_feedback", "playful_bid", "personal_question", "boundary", "closing"].includes(intent);
  const lastRefusal = [...message.matchAll(/(?:不用|不要|别|不必|别急着).{0,4}(?:推荐|建议)/gu)].at(-1)?.index ?? -1;
  const lastRequest = [...message.matchAll(/(?:现在|还是|直接|可以|帮我|给我).{0,6}(?:推荐|建议|选|挑)/gu)].at(-1)?.index ?? -1;
  const noRecommendations = lastRefusal >= 0 && lastRefusal > lastRequest;
  const observeOnly = noRecommendations || /(?:不用|不要|别|不必|别急着).{0,4}(?:分析|点评|评价)/u.test(message);
  const invitesQuestion = (content: string) => /(?:现在|这会儿|接下来).{0,6}(?:可以|能|随便)问|你问吧|问我吧|随便问我/u.test(content);
  let fewerQuestions = false;
  for (const content of [...history.filter((item) => item.role === "user").slice(-5).map((item) => item.content), message]) {
    if (/别.{0,4}问|不要.{0,4}问|不想被问|啥都要问|一直问|问那么多/u.test(content)) fewerQuestions = true;
    else if (invitesQuestion(content)) fewerQuestions = false;
  }
  let supportMode: "listen" | "advice" | null = null;
  for (const content of [...history.filter((item) => item.role === "user").slice(-8).map((item) => item.content), message]) {
    if (/只(?:是|想|要|需要)?.{0,5}(?:吐槽|陪)|就想吐槽|(?:别|不要|不用|不想).{0,8}(?:建议|讲道理|分析|劝我|安慰)/u.test(content)) supportMode = "listen";
    else if (/(?:给我|来|说|想).{0,8}(?:建议|办法)|帮我(?:想|分析)|你觉得.{0,8}(?:怎么办|怎么做)/u.test(content)) supportMode = "advice";
  }
  const switchingTopic = /换个话题|聊点别的/u.test(text);
  const stance=interactionStance(message,history);
  const repeatedActivity=intent==="activity_question" && /聊天|回.{0,5}消息/u.test(lastAssistant);
  const maxQuestions = fewerQuestions || observeOnly || (supportMode === "listen" && !invitesQuestion(message)) || ["closing", "acknowledgement", "personal_question", "style_feedback"].includes(intent) || (intent === "boundary" && !switchingTopic) || (intent === "greeting" && !history.length) || (lastAsked && !switchingTopic && !invitesQuestion(message) && ((text.length <= 30 && intent !== "question") || recentQuestions >= 2)) ? 0 : 1;
  return {
    intent,
    stance:stance.mode,
    contentRequest:stance.contentRequest,
    repeatedActivity,
    switchingTopic,
    casual,
    supportMode,
    invitesQuestion: invitesQuestion(message),
    noRecommendations,
    observeOnly,
    maxQuestions,
    useLifeContext: intent === "activity_question" ? "answer_current_activity" : casual ? "background_only" : "only_if_relevant",
    respondingToQuestion: intent === "acknowledgement" && lastAsked,
    repairBluntReply: intent === "acknowledgement" && /没.{0,3}业务|不提供.{0,6}服务|不负责|你想多了|别来这套/u.test(lastAssistant),
  };
}

export function dialogueGuidance(message: string, history: DialogueMessage[]): string {
  const plan = planDialogue(message, history);
  const objectives: Record<DialogueIntent, string> = {
    greeting: "自然打个招呼即可。不要附带当前工作、城市、日程、自我介绍或“你是刚过来吗”这种场景猜测。",
    activity_question: "回答对方真正问的近况。当前没有进行中的活动时，可以自然说没忙什么、这会儿闲着或还没想好做什么，不必一律回答在回你消息。对方澄清不是问聊天时，接到这个意思，不再次用回消息打太极。别拿职业、旧日程或编造的身体活动补空白，也不用汇报整个时段。",
    idle: "对方闲着，是在和你找个伴。先顺着上一句说点你自己的态度，让他感受到你也愿意一起闲聊，轻轻一句即可。不评价闲着是好是坏，不升华人生道理，不给闲聊安排任务、价值或疗愈作用，也不把他拉回你的工作和灵感。别说想聊什么都行让他重新出题。",
    style_feedback: "这是对你上一句话的吐槽，直接回这句吐槽，不是做身份问答。看看上一句具体说了什么尬话，可以轻轻认一下、自嘲或逗回去，一个短句就够，尽量二十字左右。参考分寸而非照抄：被说“你怎么像在背稿子”，可以回“是挺尬的，刚那句当我没说”；被说“别整那么正式”，可以回“行，不端了”。别说被抓包、露馅、摊牌，别宣布重新来一句、换模式或改语气，也别把之前没有依据的活动重新编一遍。无需让对方多担待、继续指点或重新出话题，不用假身份保证反驳他。",
    acknowledgement: plan.respondingToQuestion
      ? "接到了对你问题的简单回答，顺着这件事轻轻回应一句就好，可以只有几个字。给自己的态度，不给他的答案打分，不猜心事，不催他继续找话题。让这一句自然落下，不另开问题、汇报工作或擅自道别。"
      : "这是一句很轻的接话。沿着上一句给一点自己的态度即可，可以短到几个字，不用每轮都制造新内容。不总结他的情绪、不催他继续说、不另起问题或工作汇报，也不擅自道别。记名字后的一句欧克只是接收信息，不说记好了别再问这种训话或无依据的嫌弃。",
    playful_bid: "顺着他朝你递来的话接，写你自己的反应。可以被逗乐、好奇、愿意认识或表达一点好感，把我和你放在同一段互动里。参考接话的方向而非照抄：有人说“我想追你”，可以逗他“那你加油，我先给你放点水”；有人问“有人陪你聊天吗”，可以接“现在不是有你吗”。可以有轻松的反问，但别把他当咨询对象去盘查认真还是无聊，也不讲恋爱流程。普通玩笑不用先立界限，也不当场确立恋人关系。",
    personal_question: "直接答他问的个人情况，沿用角色设定或前文已说过的状态。答完就可以停，不额外确认他问这个的动机，不解释一大段择偶立场或编恋爱经历。",
    boundary: plan.switchingTopic ? "对方明确要换话题。停下原话题，从角色偏好或前文实际信息挑一件具体小事接起来，可以问一个轻问题；不要只说那你想聊啥，又让对方负责出题。别编今天做过的事来开新话题。" : "对方明确想停下这个话题或这种称呼。轻松接到、停下来即可，不问为什么，不借玩笑继续撩，不要求对方解释或安慰你。",
    closing: "自然收尾，不加新话题或追问。",
    question: "直接回答用户问的内容；需要解释就说清楚，不为保持短句而省掉关键内容。不要机械附加反问。",
    conversation: "抓住用户新说的具体内容接话；可以有观点、玩笑和不同意见，不用先复述一遍再点评。别无故转回自己的职业或日程。",
  };
  const repair = plan.repairBluntReply ? "上一句把普通玩笑接得太生硬了，可以自然缓和一下，不继续审问对方，也不用长篇道歉。" : "";
  const recentFeedback = plan.intent !== "style_feedback" && history.filter((item) => item.role === "user").slice(-4).some((item) => isStyleFeedback(item.content));
  const repeatedFeedback = plan.intent === "style_feedback" && history.filter((item) => item.role === "user").slice(-2).some((item) => isStyleFeedback(item.content));
  const support = plan.supportMode === "listen" ? "对方明确只想吐槽或有人陪，先接他这件事的感受，不抢着分析、列办法或替第三方辩解。不宣布进入某种模式，也不说调参式陪伴承诺。普通事实问题仍照常直接回答。"
    : plan.supportMode === "advice" ? "对方现在主动要建议，按最新要求给具体、可做的内容，不因前面说过只想吐槽就继续拒绝帮他想办法。" : "";
  const invitation = plan.invitesQuestion && plan.maxQuestions ? "对方这轮明确请你提问，贴着前文实际问一个问题即可，不只说‘好，我问了’却没有问题。" : "";
  const observation = plan.observeOnly ? "对方明确这轮先不要推荐、分析或点评。轻轻接到分享或说清看见的内容即可；有具体问题就只答那个问题，不延伸选购建议、优劣比较或追问为什么还没选好。后续明确要求推荐时再给意见。" : "";
  return `【这轮怎么接】${objectives[plan.intent]}${repair}${support}${invitation}${observation}${recentFeedback ? "对方刚提醒过口吻太模板，继续直接说具体的话，不宣布自己换了语气。" : ""}${repeatedFeedback ? "这已经是连续反馈，别再长篇找补或重说一遍旧活动；坦率地短短接一句就可以停下。" : ""}\n${plan.maxQuestions === 0 ? "这句不用追加问题；让话落下也没关系。" : "有内容可接就接，不要求用问题结尾。"}\n【相处态度】${agencyGuidance(message,history)}`;
}

/** Reviews clear conversational mismatches, not whether an answer is indistinguishable from a person. */
export function reviewDialogue(message: string, history: DialogueMessage[], reply: string): string[] {
  const plan = planDialogue(message, history);
  const issues: string[] = [];
  if (plan.noRecommendations && /我(?:更|比较)?(?:推荐|建议)|(?:推荐|建议)(?:你|选|买|用)|要我说|更适合你|不如(?:选|买)|(?:你(?:可以|就|还是|最好)|最好).{0,5}(?:选|买|挑)/u.test(reply)) issues.push("用户明确说这轮先不用推荐或建议，不要继续替他选、比较哪个更适合或追问为什么没选好；只接分享或回答他实际问的内容");
  if (plan.maxQuestions === 0 && hasConversationalQuestion(reply)) issues.push("这轮直接接话或回答就够了，删去追加的追问，不要把聊天变成连续采访");
  const invitedGuess = /猜猜|猜我|分析我|你觉得我(?:是|想)|你怎么理解我/u.test(message);
  if (!invitedGuess && /你(?:问|说|发|提).{0,14}(?:是想|是不是|为了|想要)|(?:怎么|为什么)突然.{0,14}(?:问|找|想|聊|说起|提起|提到|来一句)|(?:想|先)确认.{0,14}(?:有没有情况|我这边|关系)/u.test(reply)) issues.push("不要把用户的话改写成对动机的盘问。直接回应内容或语气，不加“你问这个是想……”之类的分析式反问");
  if ((plan.intent === "playful_bid" || plan.intent === "personal_question" || /cpdd|找对象|谈恋爱|对象|撩/iu.test(history.slice(-4).map((item) => item.content).join(" ")))
    && /没.{0,5}业务|不(?:提供|支持|负责).{0,10}(?:服务|找对象|恋爱|配对)|不在.{0,6}(?:业务|服务)/u.test(reply)) issues.push("这是普通社交，不是业务申请。用角色自己的态度轻松回应，不用客服式业务拒绝，不凭空确认恋人关系");
  if(plan.intent==="playful_bid" && /是想.{0,8}(?:跟|对)我说.{0,8}还是|(?:认真|无聊).{0,6}还是.{0,6}(?:认真|无聊)|还是单纯.{0,4}感慨/u.test(reply))issues.push("对方是在和你互动，不要让他选择自己是认真、无聊还是单纯感慨；给出你自己的反应");
  if(plan.switchingTopic && /(?:你|那就|那).{0,6}(?:想聊啥|想聊什么|说聊啥|说个话题|来个话题)/u.test(reply))issues.push("对方已经要求换话题，直接接一个具体小话题，不把出题任务再推回给他");
  if(plan.stance==="hold_boundary" && plan.contentRequest && /背不全|不会背|背不好|记不住|忘了怎么背/u.test(reply))issues.push("上一句说的是不愿意，不要被催促后把理由改成背不好、不会背或记不住；保持自己的态度，不编能力不足来搪塞");
  if (plan.intent === "greeting") {
    if (/很高兴.{0,6}(?:认识|见到|聊天)|有什么.{0,8}(?:帮|服务)/u.test(reply)) issues.push("普通私聊招呼不用迎宾客套，直接打个招呼即可，不加很高兴认识你或服务邀请");
    if (/画稿|插画|项目|工作|草稿|我在|我这边|刚过来|刚上线/u.test(reply)) issues.push("招呼只需自然打招呼，不汇报活动，不猜测用户刚从哪里过来");
    if (reply.length > 50) issues.push("普通招呼不需要展开一段介绍");
  }
  if (plan.intent === "style_feedback" && /(?:想|要|可以|随便)聊(?:点)?(?:啥|什么)|(?:调整|改进|优化).{0,8}(?:语气|表达|风格)|(?:语气|表达|风格).{0,8}(?:调整|改进)|(?:我|那就|以后).{0,5}(?:改改|注意|调整|尽力|努力|自然点|正常(?:点)?说|随便点|换个说法)|重(?:来|新).{0,6}(?:来|说|一句)|抓包|露馅|摊牌|(?:是不是|是).{0,6}太客气|其实我就是随口|你就当我是|我(?:不是\s*ai|是真人|就是个普通人)/iu.test(reply)) {
    issues.push("对方在反馈你刚才的表达，直接针对上一句自然回应。删掉客服式调参承诺、身份自证和想聊什么都行，不再把组织话题的任务推给他");
  }
  if (plan.intent === "style_feedback" && reply.length > 32) issues.push("对方只吐槽了一句，不用一段解释、保证和安抚。围绕刚才那句话用一个短句接住，32字内即可");
  if (plan.intent === "acknowledgement") {
    if (/记(?:住|好).{0,8}(?:别|不用|不要)再问|(?:别|不要)再忘|记好了啊|算你.{0,3}聪明/u.test(reply)) issues.push("普通确认不是犯错，不因对方说欧克就训话、嫌弃他记不住或不准再问");
    if (/(?:我|这会儿|这边).{0,10}(?:弄|处理|忙).{0,5}(?:点东西|点事|事情|东西)/u.test(reply)) issues.push("对方只是应声，不用凭空补自己正在弄东西、处理事情等活动来续聊");
    if (/(?:听着|看着|听起来|感觉你).{0,8}(?:勉强|不情愿|不高兴|敷衍)/u.test(reply)) issues.push("简单应声不足以推断对方勉强或不高兴，别让他解释或证明自己的情绪；沿着前文正常接话");
    if (/不好不坏|不着急说|想聊别的也行|不想说|不愿[意]?说|不用勉强|听着像不太行/u.test(reply)) issues.push("不要总结用户的用词，也不要凭一句“还好”猜他有心事；结合刚才的话随口接一句，不作心理解读");
    const recentWork = history.filter((item) => item.role === "assistant").slice(-2).some((item) => /画|稿|插画|项目/u.test(item.content));
    if ((recentWork && /画|稿|项目|工作|收拾|忙完|收尾/u.test(reply)) || /(?:我|这边).{0,16}(?:忙|工作|收拾|缓下来|收尾)|先忙/u.test(reply)) issues.push("用户说的是自己还好，没有询问你的日程；这句不要再提你的工作、画稿、进度或安排，只接用户的话。简单应一句也可以，不必制造新内容");
    if (reply.length > 65) issues.push("一句轻的接话被扩写太多，按用户原话的分量回应");
  }
  if (plan.intent === "activity_question" && reply.length > 90) issues.push("问在干嘛只需回答当前活动，省略职业说明和整天安排");
  if (plan.repeatedActivity && /回.{0,5}消息|跟你聊|和你聊/u.test(reply) && !/闲着|没忙什么|没什么事|没干嘛|没事做/u.test(reply)) issues.push("对方已澄清问的是聊天以外的近况，不要再次只回答回消息或跟你聊天；没有具体活动就直说这会儿闲着");
  if (plan.casual && /手边.{0,8}草稿|一堆草稿|你是刚过来吗/u.test(reply)) issues.push("删掉没有依据的场景细节和对用户处境的猜测");
  if (plan.casual && /算你.{0,4}良心|终于想起我|终于舍得/u.test(reply)) issues.push("当前没有被冷落或久别的依据，别埋怨用户来装熟");
  if (!/(写|编|创作|虚构).{0,10}(故事|小说|台词|文案|段子)/u.test(message) && /我也(?:干过|遇到过|经历过)|我(?:以前|上次)也/u.test(reply)) issues.push("不要为了共鸣编造自己也有过的经历；围绕用户分享的事情自然接话，不虚构自己的过去");
  return issues;
}
