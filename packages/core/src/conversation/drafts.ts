import { ModelError } from "@model";

export function draftPrompt(system: string, multiple: boolean): string {
  if (!multiple) return system;
  return `${system}\n\n【内部起草格式】为同一条私聊消息起草三个不同的自然接法，每条都能独立发送，不是连续说三句。每条通常一个短句；表达自己的反应，有具体接点，不做套话总结，不反复追问，也不编活动和经历。三个候选不要只是换同义词。最后只会选一条发出。只输出JSON：{"replies":["候选一","候选二","候选三"]}，不要输出解释或聊天正文以外的内容。`;
}

export function replyCandidates(content: string, multiple: boolean): string[] {
  if (!multiple || !/^\s*(?:\{|```)|\{\s*"replies"/u.test(content)) return [content];
  try {
    const value = JSON.parse(content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1));
    if (!value || !Array.isArray(value.replies) || !value.replies.length || value.replies.length > 3
      || !value.replies.every((reply: unknown) => typeof reply === "string" && reply.trim().length > 0 && reply.length <= 2000)) throw new Error("invalid replies");
    return [...new Set<string>(value.replies.map((reply: string) => reply.trim()))];
  } catch {
    throw new ModelError("provider returned invalid reply candidates");
  }
}
