export interface ActivitySource {
  title: string;
  details: string;
  start_time?: string | null;
  end_time?: string | null;
  source?: string;
}

export function hasIllustrationOccupation(occupation: unknown): boolean {
  return /插画|画师|画家|绘画|美术|漫画/u.test(String(occupation ?? ""));
}

/** Only identify unchanged built-in plans; an admin can independently schedule art for any role. */
export function isDefaultIllustrationTemplate(item: ActivitySource & { category?: unknown; probability?: unknown }): boolean {
  return item.title === "插画工作" && item.details === "按计划处理手头的插画项目"
    && item.start_time === "09:00" && item.end_time === "18:00"
    && item.category === "work" && Number(item.probability) === 1;
}

export function compatibleRoleActivity(item: ActivitySource, occupation: unknown): boolean {
  if (hasIllustrationOccupation(occupation)) return true;
  if (/^template:\d+$/u.test(item.source ?? "") && isDefaultIllustrationTemplate({ ...item, category: "work", probability: 1 })) return false;
  return !(item.source === "planner:work" && item.title === "整理画稿" && item.details === "整理今天的工作草稿");
}
