import { randomUUID } from "node:crypto";

import { audit, one, rows, run, transaction } from "@infra/db";
import { getOrCreateUser } from "@people/users";
import { HttpError } from "@shared/errors";
import { isoNow } from "@shared/time";
import {invalidateUserPortrait} from "../../../memory/src/portrait-invalidation";

export function listConversations() {
  return rows(`SELECT c.user_id AS id, u.display_name, c.updated_at,
    (SELECT CASE WHEN content = '' THEN '[图片]' ELSE content END FROM messages WHERE user_id = c.user_id AND channel = 'web' ORDER BY id DESC LIMIT 1) AS preview,
    (SELECT count(*) FROM messages WHERE user_id = c.user_id AND channel = 'web') AS message_count
    FROM chat_conversations c JOIN users u ON u.id = c.user_id
    ORDER BY c.updated_at DESC, c.user_id`);
}

export function touchConversation(userId: string): void {
  const now = isoNow();
  run(`INSERT INTO chat_conversations(user_id, created_at, updated_at) VALUES(?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET updated_at = excluded.updated_at`, userId, now, now);
}

export function createConversation(name: string) {
  return transaction(() => {
    const user = getOrCreateUser(`web-${randomUUID()}`, name.trim().slice(0, 80) || "新聊天");
    touchConversation(user.id);
    return { id: user.id, display_name: user.display_name };
  });
}

/** The caller serializes this operation with in-flight web replies. */
export function eraseConversation(userId: string, remove: boolean) {
  return transaction(() => {
    if (!one("SELECT user_id FROM chat_conversations WHERE user_id = ?", userId)) {
      throw new HttpError(404, "聊天不存在或已删除");
    }
    // Preserve learned memories and relationship evidence, without dangling message references.
    for (const table of ["relationship_events", "memory_candidates", "commitments"]) {
      run(`UPDATE ${table} SET source_message_id = NULL WHERE source_message_id IN
        (SELECT id FROM messages WHERE user_id = ? AND channel = 'web')`, userId);
    }
    const deleted = run("DELETE FROM messages WHERE user_id = ? AND channel = 'web'", userId).changes;
    run("DELETE FROM traces WHERE user_id = ? AND channel = 'web'", userId);
    invalidateUserPortrait(userId);
    if (remove) run("DELETE FROM chat_conversations WHERE user_id = ?", userId);
    else touchConversation(userId);
    audit(remove ? "chat_deleted" : "chat_history_cleared", { user_id: userId, messages_deleted: deleted });
    return { ok: true, messages_deleted: deleted };
  });
}
