import { ignoreUnique, one, rows, run, transaction } from "@infra/db";
import { addSeconds, isoNow } from "@shared/time";
import { workerId } from "@shared/config";

export function enqueue(kind: string, payload: Record<string, unknown> = {}, runAt?: string | null, dedupeKey?: string | null, maxAttempts = 3): number | null {
  const created = ignoreUnique(() =>
    run(
      `INSERT INTO jobs(kind, payload, run_at, status, max_attempts, dedupe_key, created_at)
       VALUES(?, ?, ?, 'pending', ?, ?, ?)`,
      kind,
      JSON.stringify(payload),
      runAt || isoNow(),
      maxAttempts,
      dedupeKey ?? null,
      isoNow(),
    ),
  );
  return created ? created.lastId : null;
}

export function claim(owner = workerId()) {
  return transaction(() => {
    const row = one("SELECT * FROM jobs WHERE status = 'pending' AND run_at <= ? ORDER BY run_at, id LIMIT 1", isoNow());
    if (!row) return null;
    const updated = run(
      "UPDATE jobs SET status = 'running', locked_by = ?, locked_at = ?, attempts = attempts + 1 WHERE id = ? AND status = 'pending'",
      owner,
      isoNow(),
      row.id,
    );
    if (updated.changes !== 1) return null;
    return { ...row, payload: JSON.parse(String(row.payload || "{}")), attempts: Number(row.attempts) + 1 };
  });
}

export function complete(jobId: number): void {
  run("UPDATE jobs SET status = 'completed', finished_at = ? WHERE id = ?", isoNow(), jobId);
}

export function fail(job: { id: number; attempts: number; max_attempts: number }, error: string): void {
  if (job.attempts >= Number(job.max_attempts)) {
    run("UPDATE jobs SET status = 'failed', last_error = ?, finished_at = ? WHERE id = ?", error.slice(0, 1000), isoNow(), job.id);
    return;
  }
  const delay = Math.min(300, 2 ** job.attempts * 5);
  run(
    "UPDATE jobs SET status = 'pending', run_at = ?, last_error = ?, locked_by = NULL, locked_at = NULL WHERE id = ?",
    addSeconds(delay),
    error.slice(0, 1000),
    job.id,
  );
}

export function stats() {
  return Object.fromEntries(rows("SELECT status, count(*) AS n FROM jobs GROUP BY status").map((row) => [String(row.status), Number(row.n)]));
}

export function recoverStale(maxAgeSeconds = 300): { recovered: number; failed: number } {
  const cutoff = addSeconds(-Math.max(30, maxAgeSeconds));
  const stale = rows("SELECT * FROM jobs WHERE status = 'running' AND locked_at < ? ORDER BY id", cutoff);
  let recovered = 0;
  let failed = 0;
  for (const job of stale) {
    if (Number(job.attempts) >= Number(job.max_attempts)) {
      failed += run(
        "UPDATE jobs SET status = 'failed', last_error = ?, finished_at = ? WHERE id = ? AND status = 'running'",
        "worker lease expired after maximum attempts",
        isoNow(),
        job.id,
      ).changes;
    } else {
      recovered += run(
        `UPDATE jobs SET status = 'pending', run_at = ?, locked_by = NULL, locked_at = NULL,
         last_error = ? WHERE id = ? AND status = 'running'`,
        isoNow(),
        "worker lease expired; recovered",
        job.id,
      ).changes;
    }
  }
  return { recovered, failed };
}
