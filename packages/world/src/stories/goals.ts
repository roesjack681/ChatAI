import { one, rows, run, transaction } from "@infra/db";
import { DomainError } from "@shared/errors";
import { businessDate, isoNow, shiftDate } from "@shared/time";

const STATUSES = new Set(["active", "blocked", "paused", "completed", "abandoned"]);
const STAGES = new Set(["exploring", "preparing", "doing", "reviewing", "completed"]);

export function listGoals(includeArchived = false) {
  const goals = rows("SELECT * FROM goals WHERE (? = 1 OR status != 'archived') ORDER BY (status = 'active') DESC, id", includeArchived ? 1 : 0);
  const events = rows("SELECT * FROM story_events ORDER BY event_date DESC, id DESC");
  return goals.map((goal) => ({
    ...goal,
    id: Number(goal.id), title: String(goal.title), description: String(goal.description), status: String(goal.status),
    progress: Number(goal.progress), stage: String(goal.stage), obstacle: String(goal.obstacle), next_action: String(goal.next_action),
    milestones: JSON.parse(String(goal.milestones || "[]")) as string[],
    events: events.filter((event) => event.goal_id === goal.id).slice(0, 20),
  }));
}

export function advance(goalId: number, summary: string, delta = 0, kind = "progress", sourceEventId: number | null = null) {
  if (!summary.trim()) throw new DomainError("进展说明不能为空");
  if (!Number.isFinite(delta) || !Number.isInteger(delta) || delta < -100 || delta > 100) throw new DomainError("progress delta must be an integer between -100 and 100");
  transaction(() => {
    const goal = one("SELECT * FROM goals WHERE id = ?", goalId);
    if (!goal) throw new DomainError("goal not found");
    if (sourceEventId != null && !one("SELECT id FROM world_events WHERE id=? AND share_level='public' AND environment='production' AND status='completed'",sourceEventId)) throw new DomainError("目标进展只能引用已完成的公开正式事件");
    if (["paused", "abandoned", "archived"].includes(String(goal.status))) throw new DomainError("暂停、放弃或归档的目标不能直接推进，请先恢复目标");
    const progress = Math.max(0, Math.min(100, Number(goal.progress) + Math.trunc(delta)));
    const status = progress === 100 ? "completed" : goal.status === "completed" ? "active" : goal.status;
    run(
      `INSERT INTO story_events(goal_id, event_date, kind, summary, progress_delta, source_event_id, created_at)
       VALUES(?, ?, ?, ?, ?, ?, ?)`,
      goalId,
      businessDate(),
      kind,
      summary.slice(0, 1000),
      progress - Number(goal.progress),
      sourceEventId,
      isoNow(),
    );
    run("UPDATE goals SET progress = ?, status = ?, stage = ?, next_action=CASE WHEN ?=100 THEN '目标已完成，可以回顾' ELSE next_action END, updated_at = ? WHERE id = ?", progress, status, progress === 100 ? "completed" : progress > 0 ? "doing" : "preparing",progress,isoNow(),goalId);
  });
  return one("SELECT * FROM goals WHERE id = ?", goalId);
}

export function review() {
  return rows("SELECT * FROM goals WHERE status IN ('active', 'blocked') ORDER BY updated_at").map((goal) => {
    const recent = Number(one(
      "SELECT count(*) AS n FROM story_events WHERE goal_id = ? AND event_date >= ? AND kind != 'plan'",
      goal.id, shiftDate(businessDate(),-7),
    )?.n ?? 0);
    return {
      goal_id: goal.id,
      action: recent ? "continue" : "schedule_opportunity",
      reason: recent ? "本周已有目标事件" : "本周尚无执行进展，可生成低优先级机会",
    };
  });
}

export function createGoal(title: string, description = "", status = "active", progress = 0, details: { stage?: string; obstacle?: string; next_action?: string; milestones?: string[] } = {}): number {
  if (!title.trim()) throw new DomainError("目标标题不能为空");
  if (!STATUSES.has(status)) throw new DomainError("invalid goal status");
  if (!Number.isInteger(progress) || progress < 0 || progress > 100) throw new DomainError("progress must be an integer between 0 and 100");
  if (details.stage && !STAGES.has(details.stage)) throw new DomainError("invalid goal stage");
  if ((status === "completed" || details.stage === "completed") && progress !== 100) throw new DomainError("完成状态必须对应100%的进度");
  if (details.milestones && (!Array.isArray(details.milestones) || details.milestones.length > 20 || details.milestones.some((item) => typeof item !== "string" || !item.trim() || item.length > 200))) throw new DomainError("invalid goal milestones");
  return run(
    "INSERT INTO goals(title,description,status,progress,stage,obstacle,next_action,milestones,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
    title.trim().slice(0,120),
    description.trim().slice(0,2000),
    progress === 100 ? "completed" : status,
    progress,
    progress === 100 ? "completed" : details.stage ?? "preparing",
    (details.obstacle ?? "").trim().slice(0,1000),
    (details.next_action ?? "").trim().slice(0,1000),
    JSON.stringify(details.milestones ?? []),
    isoNow(),
  ).lastId;
}
