export interface KnowledgeProfile {
  occupation?: string;
  knowledge_familiar?: string;
  knowledge_unfamiliar?: string;
}

export interface CharacterKnowledge {
  familiar: string;
  unfamiliar: string;
  softwareExpertise: boolean;
}

export const DEFAULT_UNFAMILIAR = "编程、服务器与容器运维、数据库和网络故障排查，以及医疗、法律、投资等专业判断";

export function characterKnowledge(profile: KnowledgeProfile): CharacterKnowledge {
  const familiar = profile.knowledge_familiar?.trim()
    || (/插画|画师|绘画|美术|设计/u.test(profile.occupation ?? "")
      ? "插画、绘画、基础配色与构图、常用绘图软件和普通日常常识"
      : "角色档案明确写出的工作与生活经验，以及普通日常常识");
  return {
    familiar,
    unfamiliar: profile.knowledge_unfamiliar?.trim() || DEFAULT_UNFAMILIAR,
    softwareExpertise: /编程|软件开发|后端开发|容器运维|服务器运维|数据库管理|计算机专业/u.test(familiar),
  };
}

export function imageConversationMode(message: string): "sharing" | "reading" | "question" {
  const text = message.trim().replace(/[。！!~～]+$/u, "");
  if (!text || /^(?:给你看看|发你看看|发给你看看|你看|看看|看看这个|看看这张图|给你看看我在忙什么|给你看我在忙什么|喏)$/u.test(text)) return "sharing";
  if (/读出|读一下|识别.{0,8}(?:字|文字|编号)|编号|写的是什么|上面写了什么|名字|标签/u.test(text)) return "reading";
  return /[？?]|为什么|怎么|如何|哪个|什么|是否|帮我|分析|评价|建议/u.test(text) ? "question" : "sharing";
}

export function knowledgeGuidance(knowledge: CharacterKnowledge, imageMessage?: string): string {
  const sharing = imageMessage !== undefined && imageConversationMode(imageMessage) === "sharing";
  return [
    "【角色认知边界，适用于文字和图片】",
    `熟悉：${knowledge.familiar}。`,
    `不熟悉：${knowledge.unfamiliar}。`,
    "始终按这个角色实际具备的知识聊天，不借用模型的通用专业知识扮演全科助理。能读出图片文字、颜色、形状，不等于懂文字背后的专业用途。图片里出现某个软件或名词，不能据此突然会操作、会诊断；可以说自己看见了什么，但别自动命名整套系统、解释组件作用、判断运行是否正常、排查故障或给操作步骤。没有被问具体内容时，更不需要逐行讲解或问“你要查哪里出问题”。",
    "不熟悉时普通地承认这块没看懂，再接住用户分享的意思，不用每次搬出职业作解释，也不必假装看不见图片。属于上面熟悉领域的内容正常聊，简单读字与辨认颜色照常做。用户刚解释过的内容可以注明是他告诉你的并沿用那一点，不由此获得整门专业能力。过去回复里即使说过越界的专业结论，也不是角色真的学会了；被追问时自然纠正，不编造学过、做过、查过资料等经历。",
    sharing ? "【这轮是分享图片】用户没有让你做识别报告或诊断。先接住他在分享的事，一句自然反应或一个围绕他的轻松问题就够了。不熟悉的界面不用硬描述，别逐行报英文名字、颜色和状态，也别先列一堆术语再说自己不懂。不要擅自把画面命名为容器列表、服务面板等专业界面。" : "",
  ].filter(Boolean).join("\n");
}

/** Catch clear software-expertise claims; visible labels alone are allowed. */
export function reviewCharacterKnowledge(reply: string, knowledge: CharacterKnowledge, input?: { hasImages: boolean; message: string }): string[] {
  if (knowledge.softwareExpertise) return [];
  const status = /(?:\b(?:web|redis|mysql|worker|migrate|nginx|docker)\b).{0,25}(?:在跑|运行|启动|停着|停了|停止|退出|正常|故障|异常|后台任务|缓存|数据库)|(?:服务|容器|进程).{0,16}(?:在跑|运行|启动|停止|退出|故障|正常|异常)/iu;
  const troubleshooting = /(?:重启|排查|检查|查看|看看|看一下|查一下|启动|执行|打开).{0,24}(?:容器|服务|日志|进程|端口|数据库)|docker\s+(?:compose|logs|ps|restart)|kubectl\s+|(?:看|查).{0,8}(?:哪个|哪里).{0,8}(?:出问题|故障)|(?:预期|应该|原本).{0,25}(?:跑着|运行|启动|退出)/iu;
  const claim = /我.{0,10}(?:也用过|做过|学过|会用|懂).{0,12}(?:docker|redis|mysql|编程|运维)/iu;
  const clauses = reply.split(/[。！？!?；;\n]|不过|但是|但我/gu);
  const oversteps = clauses.some((clause) => {
    // Attributed learning or explicitly admitting uncertainty is not an expertise claim.
    if (/你(?:刚才|刚|之前)?说|按你说|你(?:刚才|刚|之前)?(?:告诉|解释)/u.test(clause)) return false;
    const admitsLimit = /不(?:太)?(?:懂|清楚|明白|会|了解)|不熟|没学过|看不出|没看懂|不敢(?:判断|说|乱猜)/u.test(clause);
    return (!admitsLimit && (status.test(clause) || troubleshooting.test(clause) || claim.test(clause)))
      || /docker\s+(?:compose|logs|ps|restart)|kubectl\s+/iu.test(clause);
  });
  const labels = new Set(reply.toLowerCase().match(/\b(?:web|redis|mysql|worker|migrate|nginx|running|exited)\b/gu) ?? []);
  const newTechnicalTerms = input && (reply.match(/容器|服务|数据库|部署|进程|运维|故障|日志|缓存/gu) ?? []).some((term) => !input.message.includes(term));
  const unsolicitedReport = input?.hasImages && imageConversationMode(input.message) === "sharing"
    && (labels.size >= 2 || newTechnicalTerms || reply.length > 90);
  const issues: string[] = [];
  if (oversteps) issues.push("这段回复用了角色不具备的软件运维知识。只说普通人能从画面看见的内容；不懂的含义自然承认，不解释组件用途、判断服务状态或提供排查步骤。不要靠一句“不懂”后继续给专业结论，也不要照搬历史中越界的技术回复");
  if (unsolicitedReport) issues.push("用户只是在分享图片，没让你逐行识别。不熟悉的界面别罗列英文标签和状态，也别给整张图起专业名字；从普通聊天对象的角度接一句他的分享，不要做截图分析报告");
  return issues;
}
