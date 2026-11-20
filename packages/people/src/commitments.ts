import { one, rows, run } from "@infra/db";
import { DomainError } from "@shared/errors";
import { isoNow } from "@shared/time";
import { channelCanDeliverReminder, reminderChannel } from "./reminder-delivery";

export function reminderIntent(message: string): "request" | "query" | "decline" | null {
  if (!/提醒|(?:到点|明[天早晚]|后天|一会儿|\d+点).{0,8}叫我/u.test(message)) return null;
  if (/(?:不要|不用|不必|别|取消|停止).{0,6}提醒|提醒.{0,8}(?:取消|关掉|撤销)/u.test(message)) return "decline";
  if (/(?:已经|刚才|之前|上次).{0,12}(?:提醒|设|定|安排)|提醒.{0,12}(?:设好|设置好|定好|状态|成功|了吗|了没)|提醒.{0,6}(?:是否|有没有)|到点.{0,8}(?:会|能).{0,6}(?:发|提醒)|提醒我的事/u.test(message)) return "query";
  if (/提醒(?:我|一下)|记得提醒|(?:明[天早晚]|后天|到点|一会儿|\d+点).{0,8}叫我/u.test(message)) return "request";
  return "query";
}

export function isReminderRequest(message: string): boolean {
  return reminderIntent(message) === "request";
}

export function proposeFromMessage(userId: string, message: string, sourceMessageId: number | null = null) {
  if (!isReminderRequest(message)) return null;
  const title = message.replace(/^(请|帮我|你能不能|能不能)/, "").trim().slice(0, 200);
  const created = run(
    `INSERT INTO commitments(user_id, title, status, capability, source_message_id, created_at)
     VALUES(?, ?, 'proposed', 'reminder', ?, ?)`,
    userId,
    title,
    sourceMessageId,
    isoNow(),
  );
  return { id: created.lastId, status: "proposed", needs_confirmation: true };
}

export function confirm(commitmentId: number, dueAt: string) {
  const components = dueAt.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/u);
  if (!components || Number.isNaN(Date.parse(dueAt)) || Number(components[2]) < 1 || Number(components[2]) > 12
    || Number(components[3]) < 1 || Number(components[3]) > new Date(Date.UTC(Number(components[1]), Number(components[2]), 0)).getUTCDate()
    || Number(components[4]) > 23 || Number(components[5]) > 59 || Number(components[6] ?? 0) > 59) throw new DomainError("due_at must be a valid ISO datetime with timezone");
  const normalizedDueAt = isoNow(new Date(dueAt));
  const item = one("SELECT user_id, status FROM commitments WHERE id = ?", commitmentId);
  if (!item || item.status !== "proposed") throw new DomainError("commitment not found or already confirmed");
  if (!channelCanDeliverReminder(reminderChannel(String(item.user_id)))) throw new DomainError("当前提醒渠道尚不能主动投递，暂时不能确认提醒；请先配置可投递的通知渠道");
  const updated = run(
    "UPDATE commitments SET due_at = ?, status = 'pending' WHERE id = ? AND status = 'proposed'",
    normalizedDueAt,
    commitmentId,
  );
  if (updated.changes !== 1) throw new DomainError("commitment not found or already confirmed");
  return rows("SELECT * FROM commitments WHERE id = ?", commitmentId)[0];
}

export function due() {
  return rows("SELECT * FROM commitments WHERE status = 'pending' AND julianday(due_at) <= julianday(?) ORDER BY julianday(due_at), id", isoNow());
}
