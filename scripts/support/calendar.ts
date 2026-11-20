/** Validate the date being named while allowing ordinary same-month shorthand. */
export function matchesCalendarDate(reply: string, expected: string, currentDate: string): boolean {
  const [, month, day] = expected.split("-").map(Number);
  const digits = "零一二三四五六七八九";
  const chinese = (value: number) => value < 10 ? digits[value] : `${value >= 20 ? digits[Math.floor(value / 10)] : ""}十${value % 10 ? digits[value % 10] : ""}`;
  const monthPart = `(?:${month}|${chinese(month)})`;
  const dayPart = `(?:${day}|${chinese(day)})`;
  if (new RegExp(`${monthPart}月(?:份)?(?:的)?\\s*${dayPart}[日号]?`).test(reply) || reply.includes(expected)) return true;
  const namedMonths = [...reply.matchAll(/(\d{1,2}|[一二三四五六七八九十]{1,3})月/gu)].map((match) => match[1]);
  if (namedMonths.length ? !namedMonths.every((value) => value === String(month) || value === chinese(month)) : month !== Number(currentDate.slice(5, 7))) return false;
  return new RegExp(`${dayPart}[日号]`).test(reply);
}
