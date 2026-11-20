import { one, run, transaction } from "@infra/db";
import { DomainError } from "@shared/errors";
import { isoNow } from "@shared/time";

const MOODS: Record<string, [string, number, number]> = {
  calm: ["平静", 0.2, -0.2],
  happy: ["开心", 0.7, 0.3],
  tired: ["疲惫", -0.2, -0.6],
  focused: ["专注", 0.2, 0.2],
  worried: ["担心", -0.5, 0.4],
};

export function setState(scope: string, mood: string, reason = "", userId?: string | null): number {
  if (scope !== "global" && scope !== "user") throw new DomainError("invalid emotion scope");
  if (scope === "user" && !userId) throw new DomainError("user emotion requires user_id");
  const [label, valence, arousal] = MOODS[mood] ?? [mood, 0, 0];
  return run(
    `INSERT INTO emotion_states(scope, user_id, mood, valence, arousal, reason, created_at)
     VALUES(?, ?, ?, ?, ?, ?, ?)`,
    scope,
    userId ?? null,
    label,
    valence,
    arousal,
    reason.slice(0, 500),
    isoNow(),
  ).lastId;
}

export function current(userId?: string | null) {
  const globalState = one("SELECT * FROM emotion_states WHERE scope = 'global' ORDER BY id DESC LIMIT 1");
  const userState = userId
    ? one("SELECT * FROM emotion_states WHERE scope = 'user' AND user_id = ? ORDER BY id DESC LIMIT 1", userId)
    : undefined;
  return {
    global: globalState ?? { mood: "平静", valence: 0.2, arousal: -0.2 },
    user: userState ?? null,
  };
}

export function globalMood(): string {
  return String(one("SELECT value FROM settings WHERE key = 'global_mood'")?.value ?? current().global.mood ?? "平静");
}

export function setGlobalMood(mood: string): void {
  const value = mood.trim().slice(0, 120);
  if (!value) throw new DomainError("情绪状态不能为空");
  transaction(() => {
    run(
    `INSERT INTO settings(key, value, updated_at) VALUES('global_mood', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    value,
    isoNow(),
    );
    setState("global", value, "管理员设置全局基础情绪");
  });
}
