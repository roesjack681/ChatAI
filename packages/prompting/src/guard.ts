const NARRATION = [/^[（(].*?[）)]/, /^\[.*?(旁白|动作).*?\]/];

export function sanitize(text: string, worldEvents: Array<{ title: string; details: string; status: string }>): { text: string; violations: string[] } {
  const violations: string[] = [];
  let result = text.trim();
  for (const pattern of NARRATION) {
    if (pattern.test(result)) {
      result = result.replace(pattern, "").trim();
      violations.push("narration_removed");
    }
  }
  const completed = worldEvents
    .filter((event) => event.status === "completed")
    .map((event) => `${event.title} ${event.details}`)
    .join(" ");
  const risky: Array<[string, string]> = [
    ["买了相机", "我还没有确认这件事已经发生，先不把它说成事实。"],
    ["已经辞职", "这件事没有进入生活事实，我不能说它已经发生。"],
    ["已经搬家", "这件事还没有被确认，我先不把它当成已发生。"],
  ];
  for (const [phrase, replacement] of risky) {
    const roleClaim = result.split(/[，,。！？!?；;\n]/u).some((clause) => {
      const index = clause.indexOf(phrase);
      if (index < 0 || /如果|假如|假设|要是|想象|比如|是否|是不是|了吗|了没/u.test(clause)) return false;
      const prefix = clause.slice(0, index);
      const speaker = [...prefix.matchAll(/我|你|他|她|用户|知夏/gu)].at(-1)?.[0];
      return (!speaker || speaker === "我" || speaker === "知夏") && !/不(?:是|曾)|没(?:有)?/u.test(prefix);
    });
    if (roleClaim && !completed.includes(phrase)) {
      result = replacement;
      violations.push("unsupported_world_fact");
    }
  }
  return { text: result.slice(0, 2000), violations };
}
