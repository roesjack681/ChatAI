import { one } from "@infra/db";

/** Keep confirmation, dialogue diagnostics and Worker delivery on the same destination. */
export function reminderChannel(userId: string): string {
  return String(one("SELECT channel FROM identities WHERE user_id = ? ORDER BY id LIMIT 1", userId)?.channel ?? "web");
}

export function channelCanDeliverReminder(channel: string): boolean {
  const row = one("SELECT enabled, mode, config FROM channel_configs WHERE channel = ?", channel);
  try {
    const config = JSON.parse(String(row?.config ?? "{}"));
    const url = new URL(String(config.url ?? ""));
    return Boolean(row?.enabled && row.mode === "webhook" && ["http:", "https:"].includes(url.protocol));
  } catch { return false; }
}
