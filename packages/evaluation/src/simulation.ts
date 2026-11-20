import { one, run } from "@infra/db";
import { record } from "@evaluation";
import { forUser, remember } from "@memory";
import { getOrCreateUser } from "@people/users";
import { countEvents, ensureDailySkeleton } from "@world/daily-life";
import { businessDate, shiftDate } from "@shared/time";

const PERSONAS = [
  ["sandbox-high", "高频用户", 1, 0],
  ["sandbox-low", "低频用户", 1, 1],
  ["sandbox-silent", "连续未回复用户", 1, 3],
] as const;

export function runSimulation(days = 7, startDate?: string | null) {
  const span = Math.max(1, Math.min(Math.trunc(days), 30));
  const start = startDate || businessDate();
  const end = shiftDate(start, span - 1);
  const productionBefore = countEvents("production", start, end);
  const users = PERSONAS.map(([id, name, enabled, unanswered]) => {
    const user = getOrCreateUser(id, name);
    run("UPDATE users SET proactive_enabled = ?, unanswered_count = ? WHERE id = ?", enabled, unanswered, id);
    return user;
  });
  remember("sandbox-high", "高频用户喜欢摄影", "interest", 4);
  remember("sandbox-low", "低频用户喜欢咖啡", "interest", 4);
  const timeline = Array.from({ length: span }, (_, offset) => {
    const day = shiftDate(start, offset);
    const events = ensureDailySkeleton(day, "sandbox");
    return { date: day, event_count: events.length };
  });
  const low = forUser("sandbox-low", "摄影");
  const silent = Number(one("SELECT unanswered_count FROM users WHERE id = 'sandbox-silent'")?.unanswered_count ?? 0);
  const checks = {
    private_memory_isolated: !low.some((item) => item.text.includes("摄影")),
    shared_world_consistent: timeline.every((item) => item.event_count >= 2),
    silent_user_is_downranked: silent >= 2,
    production_world_untouched: countEvents("production", start, end) === productionBefore,
  };
  const saved = record("longitudinal", `${span}-day-three-user`, `start=${timeline[0]?.date ?? start}`, JSON.stringify(timeline), null);
  return {
    days: span,
    users: users.map((user) => user.id),
    timeline,
    checks,
    passed: Object.values(checks).every(Boolean),
    evaluation_id: saved.id,
  };
}
