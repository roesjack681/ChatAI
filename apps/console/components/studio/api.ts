export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...init, headers, cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError((body as { error?: string }).error || `HTTP ${response.status}`, response.status);
  return body as T;
}

export const sections = [
  ["home", "总览"],
  ["chat", "聊天"],
  ["character", "角色"],
  ["world", "生活"],
  ["stories", "目标"],
  ["npcs", "亲友"],
  ["memory", "记忆与画像"],
  ["proactive", "主动消息"],
  ["operations", "任务"],
  ["traces", "追踪"],
  ["prompts", "Prompt"],
  ["evaluate", "评测"],
  ["channels", "渠道"],
  ["settings", "配置"],
] as const;

export type Section = (typeof sections)[number][0];

export function sectionFromPath(pathname: string): Section {
  const name = pathname.split("/").filter(Boolean)[0] as Section | undefined;
  return sections.some(([id]) => id === name) ? (name as Section) : "home";
}
