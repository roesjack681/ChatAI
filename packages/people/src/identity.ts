import { randomBytes } from "node:crypto";

import { one, run, transaction } from "@infra/db";
import { DomainError } from "@shared/errors";
import { addMinutes, isoNow } from "@shared/time";
import { getOrCreateUser, type User } from "@people/users";

export function resolve(channel: string, externalId: string, displayName = "朋友"): User {
  const identity = one("SELECT user_id FROM identities WHERE channel = ? AND external_id = ?", channel, externalId);
  if (identity) return getOrCreateUser(String(identity.user_id), displayName);
  const userId = `${channel}:${externalId}`;
  const user = getOrCreateUser(userId, displayName);
  run(
    "INSERT OR IGNORE INTO identities(user_id, channel, external_id, created_at) VALUES(?, ?, ?, ?)",
    userId,
    channel,
    externalId,
    isoNow(),
  );
  return user;
}

export function createBindingCode(userId: string, ttlMinutes = 10): string {
  const code = randomBytes(8).toString("base64url");
  run(
    "INSERT INTO binding_codes(code, source_user_id, expires_at, created_at) VALUES(?, ?, ?, ?)",
    code,
    userId,
    addMinutes(ttlMinutes),
    isoNow(),
  );
  return code;
}

export function bind(code: string, targetChannel: string, targetExternalId: string): string {
  return transaction(() => {
    const item = one(
      "SELECT * FROM binding_codes WHERE code = ? AND consumed_at IS NULL AND expires_at > ?",
      code,
      isoNow(),
    );
    if (!item) throw new DomainError("绑定码无效或已过期");
    const existing = one("SELECT user_id FROM identities WHERE channel = ? AND external_id = ?", targetChannel, targetExternalId);
    if (existing && existing.user_id !== item.source_user_id) {
      throw new DomainError("目标账号已绑定到其他身份，需要先解除冲突");
    }
    run(
      `INSERT INTO identities(user_id, channel, external_id, created_at) VALUES(?, ?, ?, ?)
       ON CONFLICT(channel, external_id) DO UPDATE SET user_id = excluded.user_id`,
      item.source_user_id,
      targetChannel,
      targetExternalId,
      isoNow(),
    );
    run("UPDATE binding_codes SET consumed_at = ? WHERE code = ?", isoNow(), code);
    return String(item.source_user_id);
  });
}
