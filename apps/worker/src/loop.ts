import { audit, one, run, transaction } from "@infra/db";
import { workerId, workerPollMs } from "@shared/config";
import { due } from "@people/commitments";
import { reminderChannel } from "../../../packages/people/src/reminder-delivery";
import { queue, dispatchPending } from "@core/delivery";
import { complete, claim, enqueue, fail, recoverStale } from "@core/jobs";
import { extractUnprocessedWithModel, processPending } from "@memory";
import {portraitInputAvailable,refreshUserPortrait} from "../../../packages/memory/src/portrait";
import { schedule, seedFromWorld } from "@proactive";
import { review } from "@world/stories";
import { addHours, businessDate, clockNow, isoNow, shiftDate, weekdayIndex } from "@shared/time";
import { ensureDailySkeleton, transitionDue } from "@world/daily-life";

type Job = { id: number; kind: string; payload: Record<string, unknown>; attempts: number; max_attempts: number };

const workerStartedAt = isoNow();

function heartbeat(status = "running", job?: { id?: number; kind?: string }, error = ""): void {
  run(
    `INSERT INTO worker_heartbeats(worker_id, started_at, last_seen_at, status, last_job_id, last_job_kind, last_error)
     VALUES(?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(worker_id) DO UPDATE SET started_at = excluded.started_at, last_seen_at = excluded.last_seen_at, status = excluded.status,
       last_job_id = coalesce(excluded.last_job_id, worker_heartbeats.last_job_id),
       last_job_kind = coalesce(excluded.last_job_kind, worker_heartbeats.last_job_kind),
       last_error = excluded.last_error`,
    workerId(), workerStartedAt, isoNow(), status, job?.id ?? null, job?.kind ?? null, error.slice(0, 1000),
  );
}

export function cleanupRetention() {
  const completedJobs = run("DELETE FROM jobs WHERE status = 'completed' AND finished_at < ?", addHours(-24)).changes;
  const failedJobs = run("DELETE FROM jobs WHERE status = 'failed' AND finished_at < ?", addHours(-24 * 30)).changes;
  const outbox = run("DELETE FROM outbox WHERE status IN ('sent', 'failed') AND created_at < ?", addHours(-24 * 30)).changes;
  const routineAudit = run("DELETE FROM audit_log WHERE action = 'job_completed' AND created_at < ?", addHours(-24 * 7)).changes;
  const oldAudit = run("DELETE FROM audit_log WHERE created_at < ?", addHours(-24 * 180)).changes;
  const sandboxEvents = run("DELETE FROM world_events WHERE environment = 'sandbox' AND event_date < ?", shiftDate(businessDate(), -30)).changes;
  const staleWorkers = run("DELETE FROM worker_heartbeats WHERE worker_id != ? AND last_seen_at < ?", workerId(), addHours(-24 * 7)).changes;
  return { completedJobs, failedJobs, outbox, routineAudit, oldAudit, sandboxEvents, staleWorkers };
}

async function handle(job: Job) {
  const payload = job.payload ?? {};
  switch (job.kind) {
    case "daily_plan":
      return { events: ensureDailySkeleton(String(payload.date || businessDate())).length };
    case "world_tick":
      return transitionDue(payload.date ? String(payload.date) : undefined, payload.time ? String(payload.time) : undefined);
    case "memory_batch":
      return processPending(Number(payload.limit ?? 50));
    case "memory_extract":
      return extractUnprocessedWithModel(Number(payload.limit ?? 20));
    case "user_portrait": {
      const userId=String(payload.user_id??"");
      if(!one("SELECT id FROM users WHERE id=?",userId)||!portraitInputAvailable(userId))return {skipped:"no_content"};
      const view=await refreshUserPortrait(userId);return {user_id:userId,status:view.portrait.status,traits:view.portrait.traits.length};
    }
    case "weekly_story_review":
      return { suggestions: review() };
    case "proactive_schedule":
      return schedule(Number(payload.limit ?? 1000));
    case "proactive_seed":
      return seedFromWorld();
    case "dispatch_outbox":
      return dispatchPending(Number(payload.limit ?? 50));
    case "commitment_due": {
      let queued = 0;
      for (const item of due()) {
        const created = transaction(() => {
          if (!run("UPDATE commitments SET status = 'queued' WHERE id = ? AND status = 'pending'", item.id).changes) return false;
          const channel = reminderChannel(String(item.user_id));
          queue(String(item.user_id), channel, `提醒你：${item.title}`, "reminder", `commitment:${item.id}`);
          return true;
        });
        if (created) queued += 1;
      }
      return { queued };
    }
    case "maintenance_cleanup":
      return cleanupRetention();
    default:
      throw new Error(`unknown job kind: ${job.kind}`);
  }
}

export function ensureRecurringJobs(): void {
  const minute = isoNow().slice(0, 16).replace(/[-:T]/g, "");
  const day = businessDate();
  enqueue("daily_plan", { date: day }, null, `daily-plan:${day}`);
  enqueue("world_tick", {}, null, `world-tick:${minute}`);
  enqueue("memory_batch", {}, null, `memory-batch:${minute}`);
  enqueue("memory_extract", {}, null, `memory-extract:${minute}`);
  enqueue("proactive_schedule", {}, null, `proactive:${minute}`);
  enqueue("proactive_seed", {}, null, `proactive-seed:${minute}`);
  enqueue("dispatch_outbox", {}, null, `outbox:${minute}`);
  enqueue("commitment_due", {}, null, `commitments:${minute}`);
  enqueue("maintenance_cleanup", {}, null, `maintenance:${day}`);
  if (weekdayIndex(day) === 0) enqueue("weekly_story_review", {}, null, `story-review:${day}`);
}

export async function runOnce() {
  const job = claim(workerId()) as Job | null;
  if (!job) return null;
  try {
    const result = await handle(job);
    complete(job.id);
    heartbeat("running", job);
    audit("job_completed", { job_id: job.id, kind: job.kind, result }, workerId());
    return { job: job.id, kind: job.kind, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(job, message);
    heartbeat("degraded", job, message);
    audit("job_failed", { job_id: job.id, kind: job.kind, error: message }, workerId());
    return { job: job.id, kind: job.kind, error: message };
  }
}

export async function loop(): Promise<void> {
  console.log(`Companion worker started: ${workerId()}`, { clock: clockNow() });
  heartbeat();
  const recovered = recoverStale();
  if (recovered.recovered || recovered.failed) audit("stale_jobs_recovered", recovered, workerId());
  let last = 0;
  // Model extraction and webhook batches can outlast the health window while awaiting I/O.
  const heartbeatTimer = setInterval(() => {
    try { heartbeat(); }
    catch (error) { console.error("Worker heartbeat failed", error); }
  }, 30_000);
  try {
    for (;;) {
      const current = Date.now();
      if (current - last >= 30_000) {
        ensureRecurringJobs();
        heartbeat();
        last = current;
      }
      const result = await runOnce();
      if (result) console.log(JSON.stringify(result));
      else await new Promise((resolve) => setTimeout(resolve, workerPollMs()));
    }
  } finally { clearInterval(heartbeatTimer); }
}
