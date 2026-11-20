const TIMEZONE = "Asia/Shanghai";

function parts(date: Date) {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) => formatted.find((part) => part.type === type)?.value ?? "";
  return {
    year: pick("year"),
    month: pick("month"),
    day: pick("day"),
    hour: pick("hour") === "24" ? "00" : pick("hour"),
    minute: pick("minute"),
    second: pick("second"),
    weekday: pick("weekday"),
  };
}

/** Shanghai local time, always with an explicit offset so string comparison stays ordered. */
export function isoNow(date = new Date()): string {
  const value = parts(date);
  return `${value.year}-${value.month}-${value.day}T${value.hour}:${value.minute}:${value.second}+08:00`;
}

export function businessDate(date = new Date()): string {
  const value = parts(date);
  return `${value.year}-${value.month}-${value.day}`;
}

export function hourNow(date = new Date()): number {
  return Number(parts(date).hour);
}

export function clockNow(date = new Date()): string {
  const value = parts(date);
  return `${value.hour}:${value.minute}`;
}

export function weekdayIndex(day = businessDate()): number {
  const noon = new Date(`${day}T12:00:00+08:00`);
  const label = parts(noon).weekday;
  const index = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(label);
  return index >= 0 ? index : noon.getUTCDay() === 0 ? 6 : noon.getUTCDay() - 1;
}

export function addSeconds(seconds: number, date = new Date()): string {
  return isoNow(new Date(date.getTime() + seconds * 1000));
}

export function addMinutes(minutes: number, date = new Date()): string {
  return addSeconds(minutes * 60, date);
}

export function addHours(hours: number, date = new Date()): string {
  return addSeconds(hours * 3600, date);
}

export function shiftDate(day: string, offset: number): string {
  const noon = new Date(`${day}T12:00:00+08:00`);
  noon.setUTCDate(noon.getUTCDate() + offset);
  return businessDate(noon);
}
