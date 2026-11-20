import { deepseek } from "@shared/config";
import type { ModelImage } from "@shared/images";

export interface ModelMessage { role: string; content: string; images?: ModelImage[]; created_at?: string }
export interface GenerationOptions { temperature?: number; maxTokens?: number; thinking?: boolean; json?: boolean }

export interface Usage {
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
}

export class ModelError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "ModelError";
  }
}

const LOCAL: Usage = { provider: "local", model: "offline-fallback", input_tokens: 0, output_tokens: 0 };

export function localReply(message: string): string {
  const text = message.trim();
  if (!text) return "我在呢。";
  if (["晚安", "睡了", "先睡"].some((token) => text.includes(token))) return "晚安，好好休息。";
  if (text.includes("昨天") || text.includes("今天干嘛") || text.includes("今天做了什么")) {
    return "我先确认一下今天的安排，已经发生的事我不想记错。";
  }
  if (text.includes("以后不要叫我") || text.includes("以后别叫我")) return "好，记住了，之后我会注意。";
  if (text.length <= 8) return "嗯嗯，我听着呢。";
  const remembered = ["我喜欢", "我不喜欢", "以后"].some((token) => text.includes(token));
  return `我听到了。${remembered ? "这件事我记下了。" : "你愿意多说一点吗？"}`;
}

export async function generate(
  system: string,
  history: ModelMessage[],
  userMessage: string,
  images: ModelImage[] = [],
  options: GenerationOptions = {},
): Promise<{ content: string; usage: Usage }> {
  const config = deepseek();
  const hasImages = images.length > 0 || history.some((message) => message.images?.length);
  if (!config.apiKey) {
    if (hasImages) throw new ModelError("image understanding requires a configured model");
    return { content: localReply(userMessage), usage: LOCAL };
  }
  const content = (message: ModelMessage) => message.role === "user" && message.images?.length
    ? [ ...(message.content ? [{ type: "text", text: message.content }] : []), ...message.images.map((image) => ({ type: "image_url", image_url: { url: image.data_url, detail: "auto" } })) ]
    : message.content;
  const messages = [{ role: "system", content: system }, ...history.slice(-12).map((message) => ({ role: message.role, content: content(message) })), { role: "user", content: content({ role: "user", content: userMessage, images }) }];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), hasImages || options.thinking ? 60_000 : 35_000);
  try {
    let inputTokens = 0;
    let outputTokens = 0;
    for (let attempt = 0; attempt < (options.json ? 2 : 1); attempt += 1) {
      const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: config.model, messages, thinking: { type: options.thinking ? "enabled" : "disabled" }, response_format: options.json ? { type: "json_object" } : undefined, temperature: options.temperature ?? 0.75, max_tokens: options.maxTokens ?? 1024 }),
        signal: controller.signal,
      });
      if (!response.ok) throw new ModelError(`provider status ${response.status}`, response.status);
      const result = (await response.json()) as {
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      inputTokens += result.usage?.prompt_tokens ?? 0;
      outputTokens += result.usage?.completion_tokens ?? 0;
      if (result.choices?.[0]?.finish_reason === "length") throw new ModelError("provider response exceeded token budget");
      const content = result.choices?.[0]?.message?.content?.trim() ?? "";
      if (!content) continue;
      return { content, usage: { provider: "deepseek", model: config.model, input_tokens: inputTokens, output_tokens: outputTokens } };
    }
    throw new ModelError("provider returned an empty response");
  } catch (error) {
    if (error instanceof ModelError) throw error;
    throw new ModelError(error instanceof Error ? error.message : "provider request failed");
  } finally {
    clearTimeout(timer);
  }
}
