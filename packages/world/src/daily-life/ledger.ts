import { createHash } from "node:crypto";

import { audit, one, rows, run, transaction } from "@infra/db";
import { portrait } from "@character";
import { DomainError } from "@shared/errors";
import { businessDate, clockNow, isoNow, weekdayIndex } from "@shared/time";
import { compatibleRoleActivity, hasIllustrationOccupation, isDefaultIllustrationTemplate } from "./defaults";

const STATUSES = new Set(["planned", "ongoing", "completed", "cancelled", "postponed"]);
const SHARE_LEVELS = new Set(["public", "private"]);
const ENVIRONMENTS = new Set(["production", "sandbox"]);

export interface WorldEvent {
  id: number;
  event_date: string;
  start_time: string | null;
  end_time: string | null;
  title: string;
  details: string;
  status: string;
  source: string;
  share_level: string;
  user_id: string | null;
}

function mapEvent(row: Record<string, unknown>): WorldEvent {
  return {
    id: Number(row.id),
    event_date: String(row.event_date),
    start_time: row.start_time == null ? null : String(row.start_time),
    end_time: row.end_time == null ? null : String(row.end_time),
    title: String(row.title),
    details: String(row.details ?? ""),
    status: String(row.status),
    source: String(row.source ?? ""),
    share_level: String(row.share_level),
    user_id: row.user_id == null ? null : String(row.user_id),
  };
}

function minutes(value: string | null | undefined): number | null {
  if (!value) return null;
  const [hour, minute] = value.split(":").map((part) => Number(part));
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

export function events(day = businessDate(), includePrivateFor: string | null = null, environment = "production"): WorldEvent[] {
  return rows(
    `SELECT id, event_date, start_time, end_time, title, details, status, source, share_level, user_id
     FROM world_events
     WHERE environment = ? AND event_date = ? AND (share_level = 'public' OR user_id = ?)
     ORDER BY start_time, id`,
    environment,
    day,
    includePrivateFor ?? "",
  ).map(mapEvent);
}

export function addEvent(input: {
  title: string;
  details?: string;
  day?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  status?: string;
  shareLevel?: string;
  userId?: string | null;
  source?: string;
  environment?: string;
}): number {
  const status = input.status || "planned";
  const shareLevel = input.shareLevel || "public";
  const environment = input.environment || "production";
  if (!input.title.trim()) throw new DomainError("事件标题不能为空");
  if (!STATUSES.has(status)) throw new DomainError("invalid event status");
  if (!SHARE_LEVELS.has(shareLevel)) throw new DomainError("invalid share level");
  if (shareLevel === "private" && !input.userId) throw new DomainError("private events require a user");
  if (!ENVIRONMENTS.has(environment)) throw new DomainError("invalid environment");
  const day = input.day || businessDate();
  const parsedDay = new Date(`${day}T12:00:00+08:00`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(day) || Number.isNaN(parsedDay.getTime()) || businessDate(parsedDay) !== day) throw new DomainError("事件日期无效");
  for (const time of [input.startTime,input.endTime]) if (time && (!/^\d{2}:\d{2}$/u.test(time) || minutes(time) == null)) throw new DomainError("事件时间必须是有效HH:MM");
  if (input.endTime && (!input.startTime || Number(minutes(input.endTime)) <= Number(minutes(input.startTime)))) throw new DomainError("结束时间必须晚于开始时间");
  return run(
    `INSERT INTO world_events(event_date, start_time, end_time, title, details, status, source, share_level, user_id, environment, created_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    day,
    input.startTime ?? null,
    input.endTime ?? null,
    input.title.trim().slice(0, 120),
    (input.details ?? "").trim().slice(0, 1000),
    status,
    input.source ?? "admin",
    shareLevel,
    input.userId ?? null,
    environment,
    isoNow(),
  ).lastId;
}

export function hasConflict(day: string, startTime: string, endTime?: string | null, environment = "production", excludeId?: number): boolean {
  const start = minutes(startTime);
  if (start == null) return false;
  const end = endTime ? minutes(endTime) ?? start + 60 : start + 60;
  return events(day, null, environment).some((item) => {
    if (excludeId && item.id === excludeId) return false;
    const otherStart = minutes(item.start_time);
    if (otherStart == null) return false;
    const otherEnd = minutes(item.end_time) ?? otherStart + 60;
    return start < otherEnd && otherStart < end;
  });
}

export function updateStatus(eventId: number, status: string): boolean {
  if (!STATUSES.has(status)) throw new DomainError("invalid event status");
  return run("UPDATE world_events SET status = ? WHERE id = ?", status, eventId).changes > 0;
}

function seededRandom(seedText: string): () => number {
  const digest = createHash("sha256").update(seedText).digest();
  let state = digest.readBigUInt64BE(0);
  return () => {
    state = (state * 6364136223846793005n + 1n) & ((1n << 64n) - 1n);
    return Number(state >> 11n) / Number(1n << 53n);
  };
}

export function ensureDailySkeleton(day = businessDate(), environment = "production"): WorldEvent[] {
  const occupation = portrait().occupation;
  retireIncompatibleDefaultActivities(day, environment);
  const templates = rows(
    "SELECT * FROM schedule_templates WHERE enabled = 1 AND (weekday IS NULL OR weekday = ?) ORDER BY start_time, id",
    weekdayIndex(day),
  );
  const random = seededRandom(`${environment}:${day}`);
  for (const template of templates) {
    if (random() > Number(template.probability)) continue;
    if (!hasIllustrationOccupation(occupation) && isDefaultIllustrationTemplate(template as unknown as Parameters<typeof isDefaultIllustrationTemplate>[0])) continue;
    const exists = one(
      "SELECT id FROM world_events WHERE environment = ? AND event_date = ? AND start_time = ? AND title = ?",
      environment,
      day,
      template.start_time,
      template.title,
    );
    if (exists) continue;
    if (!hasConflict(day, String(template.start_time), template.end_time == null ? null : String(template.end_time), environment)) {
      addEvent({
        title: String(template.title),
        details: String(template.details ?? ""),
        day,
        startTime: String(template.start_time),
        endTime: template.end_time == null ? null : String(template.end_time),
        status: "planned",
        source: `template:${template.id}`,
        environment,
      });
    }
  }
  const optional: Array<[string, string, string, string]> = [
    ["19:30", "摄影练习", "为街头摄影目标安排一次练习", "goal"],
    ["20:00", "散步", "在附近走走，恢复精力", "daily"],
    hasIllustrationOccupation(occupation) ? ["20:30", "整理画稿", "整理今天的工作草稿", "work"] : ["20:30", "整理待办", "整理接下来想做的事情", "daily"],
  ];
  if (random() < 0.65) {
    const choice = optional[Math.floor(random() * optional.length)] ?? optional[0];
    const [at, title, details, source] = choice;
    const exists = one(
      "SELECT id FROM world_events WHERE environment = ? AND event_date = ? AND start_time = ? AND title = ?",
      environment,
      day,
      at,
      title,
    );
    if (!exists && !hasConflict(day, at, null, environment)) {
      addEvent({ title, details, day, startTime: at, status: "planned", source: `planner:${source}`, environment });
    }
  }
  return events(day, null, environment);
}

export function retireIncompatibleDefaultActivities(day = businessDate(), environment = "production"): number {
  const occupation = portrait().occupation;
  if (hasIllustrationOccupation(occupation)) return 0;
  const stale = rows("SELECT * FROM world_events WHERE environment = ? AND event_date >= ? AND share_level = 'public' AND status IN ('planned', 'ongoing')", environment, day)
    .filter((event) => !compatibleRoleActivity(event as unknown as WorldEvent, occupation));
  if (!stale.length) return 0;
  return transaction(() => {
    let changed = 0;
    for (const event of stale) changed += run("UPDATE world_events SET status = 'cancelled' WHERE id = ? AND status IN ('planned', 'ongoing')", event.id).changes;
    audit("default_role_activities_retired", { event_ids: stale.map((event) => event.id), occupation }, "system");
    return changed;
  });
}

export function transitionDue(day = businessDate(), currentTime = clockNow()): { started: number; completed: number } {
  retireIncompatibleDefaultActivities(day);
  let started = 0;
  let completed = 0;
  for (const item of events(day)) {
    if (item.end_time && item.end_time <= currentTime && item.status === "ongoing") {
      completed += run("UPDATE world_events SET status = 'completed' WHERE id = ? AND status = 'ongoing'", item.id).changes;
      continue;
    }
    if (item.start_time && item.start_time <= currentTime && item.status === "planned") {
      if (item.end_time && item.end_time <= currentTime) {
        completed += run("UPDATE world_events SET status = 'completed' WHERE id = ? AND status = 'planned'", item.id).changes;
      } else {
        started += run("UPDATE world_events SET status = 'ongoing' WHERE id = ? AND status = 'planned'", item.id).changes;
      }
    }
  }
  return { started, completed };
}

export function dailySummary(day = businessDate()): string {
  const items = events(day);
  if (!items.length) return "当天没有已登记的生活事实。";
  return items.map((item) => `${item.start_time || "待定"} ${item.title}[${item.status}]`).join("；");
}

export function countEvents(environment: string, from: string, to: string): number {
  return Number(one(
    "SELECT count(*) AS n FROM world_events WHERE environment = ? AND event_date BETWEEN ? AND ?",
    environment,
    from,
    to,
  )?.n ?? 0);
}

export function scheduleTemplates() {
  return rows("SELECT * FROM schedule_templates ORDER BY weekday, start_time, id");
}

export function saveScheduleTemplate(input: {
  id?: number | null;
  weekday?: number | null;
  startTime: string;
  endTime?: string | null;
  title: string;
  details?: string;
  category?: string;
  probability?: number;
  enabled?: boolean;
}): number {
  const weekday = input.weekday == null ? null : Number(input.weekday);
  const probability = input.probability == null ? 1 : Number(input.probability);
  if (weekday != null && (!Number.isInteger(weekday) || weekday < 0 || weekday > 6)) throw new DomainError("weekday must be 0..6 or null");
  if (!/^\d{2}:\d{2}$/.test(input.startTime) || minutes(input.startTime) == null) throw new DomainError("start time must be HH:MM");
  if (input.endTime && (!/^\d{2}:\d{2}$/.test(input.endTime) || minutes(input.endTime) == null)) throw new DomainError("end time must be HH:MM");
  if (input.endTime && Number(minutes(input.endTime)) <= Number(minutes(input.startTime))) throw new DomainError("end time must be after start time");
  if (!input.title.trim()) throw new DomainError("日程标题不能为空");
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new DomainError("probability must be between 0 and 1");
  if (input.id) {
    const changed = run(
      `UPDATE schedule_templates SET weekday = ?, start_time = ?, end_time = ?, title = ?, details = ?,
       category = ?, probability = ?, enabled = ? WHERE id = ?`,
      weekday,
      input.startTime,
      input.endTime ?? null,
      input.title.trim().slice(0, 120),
      (input.details ?? "").trim().slice(0, 1000),
      (input.category ?? "routine").slice(0, 40),
      probability,
      input.enabled === false ? 0 : 1,
      input.id,
    );
    if (!changed.changes) throw new DomainError("schedule template not found");
    return input.id;
  }
  return run(
    `INSERT INTO schedule_templates(weekday, start_time, end_time, title, details, category, probability, enabled, created_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    weekday,
    input.startTime,
    input.endTime ?? null,
    input.title.trim().slice(0, 120),
    (input.details ?? "").trim().slice(0, 1000),
    (input.category ?? "routine").slice(0, 40),
    probability,
    input.enabled === false ? 0 : 1,
    isoNow(),
  ).lastId;
}
