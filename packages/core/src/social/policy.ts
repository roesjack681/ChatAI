import { planDialogue, type DialogueMessage } from "../../../prompting/src/dialogue";

export interface ContactUser {
  proactive_enabled: number;
  quiet_start: string;
  quiet_end: string;
  unanswered_count: number;
}

export function canProactivelyContact(user: ContactUser, localHour: number, hasUnanswered = false): { allowed: boolean; reason: string } {
  if (!user.proactive_enabled) return { allowed: false, reason: "用户未授权主动消息" };
  if (hasUnanswered || user.unanswered_count >= 2) return { allowed: false, reason: "用户尚未回复，暂缓主动联系" };
  const start = Number(user.quiet_start.slice(0, 2));
  const end = Number(user.quiet_end.slice(0, 2));
  const quiet = start < end ? start <= localHour && localHour < end : localHour >= start || localHour < end;
  if (quiet) return { allowed: false, reason: "处于免打扰时段" };
  return { allowed: true, reason: "允许在随机窗口内选择候选话题" };
}

export function decideReply(message: string, history: DialogueMessage[] = []): string {
  const { intent } = planDialogue(message, history);
  if (intent === "closing") return "warm_close";
  if (intent === "greeting") return "greet";
  if (intent === "activity_question") return "answer_activity";
  if (intent === "playful_bid") return "playful_connection";
  if (intent === "personal_question") return "answer_personal";
  if (intent === "acknowledgement") return "brief_acknowledgement";
  if (intent === "style_feedback") return "respond_to_style_feedback";
  if (intent === "idle") return "casual_company";
  return "conversation";
}
