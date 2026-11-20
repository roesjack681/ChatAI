import { rows } from "@infra/db";
import type { DialogueMessage } from "../../../prompting/src/dialogue";
import { conversationContract, type ConversationContract } from "./capabilities";

export function recallConversation(userId: string, channel: string, message: string, recent: DialogueMessage[]): { contract: ConversationContract; evidence: DialogueMessage[] } {
  const records = rows("SELECT id, role, content, created_at FROM messages WHERE user_id = ? AND channel = ? ORDER BY id DESC LIMIT 60", userId, channel).reverse();
  const quoted = (item: Record<string, unknown>): DialogueMessage => ({ role: String(item.role), content: String(item.content), created_at: String(item.created_at) });
  const history = records.map(quoted);
  const contract = conversationContract(message, history);
  let words: string[] = [];
  let focus: string[] = [];
  if (contract.gamingContext || contract.action === "contact_exchange" || contract.action === "game_session") words = ["游戏", "王者", "开黑", "账号", "ID", "加你", "加我", "微信", "QQ"];
  else if (contract.requestedDetail === "music" || /之前.{0,8}(?:歌|听)|那首/u.test(message)) words = ["歌", "音乐", "在听", "乐队"];
  else if (contract.requestedDetail === "book") words = ["书", "读", "小说", "作者"];
  else if (contract.action) words = ["见面", "出来", "电话", "语音", "自拍", "定位", "提醒", "下单"];
  else if (/记得|之前|前面|刚才|上次|那只|那个|叫什么|叫啥|什么名字/u.test(message)
    || /(?:我|我的).{0,24}(?:什么|啥|哪|几岁|多少|能不能|可不可以|喜不喜欢)/u.test(message)) {
    // Keep the subject of the question, rather than only the polarity of an old statement.
    // E.g. “吃辣” must also find “能吃一点辣”, not just “不吃”.
    const subject = message
      .replace(/还记得|记不记得|记得|最开始|之前|前面|刚才|上次|现在|以前|到底|平时|一般|能不能|可不可以|喜不喜欢|是不是|是否|什么名字|什么时候|叫什么|叫啥|什么|哪个|哪里|哪儿|哪天|几月|几日|几号|多少|告诉|提过|说过/gu, " ")
      .replace(/[我你他她它的了呢吗嘛呀啊吧这那不没也就都还再个啥哪是有在]|吃|喝|叫|说/gu, " ");
    focus = [...new Set(subject.match(/[\p{Script=Han}]{1,12}|[A-Za-z0-9]{2,32}/gu) ?? [])].slice(0, 6);
    const topics: Array<[RegExp, string[]]> = [
      [/猫|狗|宠物|毛孩子/u, ["猫", "狗", "宠物", "毛孩子"]],
      [/室友|舍友/u, ["室友", "舍友"]],
      [/朋友|同学|同事/u, ["朋友", "同学", "同事"]],
      [/家人|爸|妈|哥哥|姐姐|弟弟|妹妹/u, ["家人", "爸爸", "妈妈", "哥哥", "姐姐", "弟弟", "妹妹"]],
      [/称呼|叫我|我叫|名字/u, ["叫我", "我叫", "称呼", "名字"]],
      [/去哪|出差|旅行|行程|考试/u, ["出差", "旅行", "行程", "考试", "明天去", "打错了"]],
      [/吃|喜欢|讨厌|爱好/u, ["喜欢", "不吃", "讨厌", "爱好"]],
    ];
    words = topics.find(([pattern]) => pattern.test(message))?.[1] ?? [];
  }
  if ((!words.length && !focus.length) || !records.length) return { contract, evidence: [] };
  const cutoff = Number(records[Math.max(0, records.length - recent.length)]?.id ?? Number.MAX_SAFE_INTEGER);
  const search = (terms: string[]) => rows(`SELECT id, role, content, created_at FROM messages WHERE user_id = ? AND channel = ? AND id < ?
    AND (${terms.map(() => "content LIKE ?").join(" OR ")}) ORDER BY id DESC LIMIT 8`, userId, channel, cutoff, ...terms.map((word) => `%${word}%`));
  let matches = search(focus.length ? focus : words);
  if (!matches.length && focus.length && words.length) matches = search(words);
  const selected = new Map<number, DialogueMessage>();
  for (const match of matches) {
    selected.set(Number(match.id), quoted(match));
    const next = rows("SELECT id, role, content, created_at FROM messages WHERE user_id = ? AND channel = ? AND id > ? AND id < ? ORDER BY id LIMIT 1", userId, channel, match.id, cutoff)[0];
    if (next) selected.set(Number(next.id), quoted(next));
  }
  const evidence = [...selected].sort(([a], [b]) => a - b).slice(-10).map(([, item]) => item);
  return { contract: conversationContract(message, [...evidence, ...history]), evidence };
}
