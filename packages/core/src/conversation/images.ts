import { randomUUID } from "node:crypto";
import sharp from "sharp";

import { one, rows, run } from "@infra/db";
import { DomainError, HttpError } from "@shared/errors";
import { MAX_CHAT_IMAGES, MAX_IMAGE_BYTES, MAX_MESSAGE_IMAGE_BYTES, type ChatImage, type ModelImage } from "@shared/images";

export interface PreparedImage {
  name: string;
  data: Buffer;
  mime_type: string;
  width: number;
  height: number;
}

function supportedMagic(data: Buffer): boolean {
  return data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || (data[0] === 255 && data[1] === 216 && data[2] === 255)
    || /^GIF8[79]a$/u.test(data.subarray(0, 6).toString("ascii"))
    || (data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP");
}

export async function prepareImages(input: unknown): Promise<PreparedImage[]> {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new DomainError("images 必须是图片数组");
  if (input.length > MAX_CHAT_IMAGES) throw new DomainError(`每条消息最多 ${MAX_CHAT_IMAGES} 张图片`);
  let total = 0;
  const originals = input.map((item: unknown) => {
    if (!item || typeof item !== "object" || !("data_url" in item) || typeof item.data_url !== "string") throw new DomainError("图片缺少 data_url");
    if (item.data_url.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 100) throw new DomainError("单张图片不能超过 5 MB");
    const match = item.data_url.match(/^data:image\/(?:jpeg|jpg|png|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/u);
    if (!match) throw new DomainError("仅支持 JPEG、PNG、WebP、GIF 图片，不接受外部链接");
    const data = Buffer.from(match[1], "base64");
    if (!data.length || data.toString("base64") !== match[1] || !supportedMagic(data)) throw new DomainError("图片格式无效或文件已损坏");
    if (data.length > MAX_IMAGE_BYTES) throw new DomainError("单张图片不能超过 5 MB");
    total += data.length;
    if (total > MAX_MESSAGE_IMAGE_BYTES) throw new DomainError("每条消息的图片总大小不能超过 12 MB");
    const name = "name" in item && typeof item.name === "string" ? item.name : "图片";
    return { name: name.replace(/[\x00-\x1f\x7f/\\]/gu, "_").slice(0, 120) || "图片", data };
  });
  const result: PreparedImage[] = [];
  for (const original of originals) {
    try {
      const image = sharp(original.data, { limitInputPixels: 40_000_000, failOn: "error" });
      const metadata = await image.metadata();
      if (!metadata.width || !metadata.height || metadata.width > 8192 || metadata.height > 8192) throw new Error("dimensions");
      // Decode fully, orient, resize and strip metadata. GIF uploads use their first frame.
      const { data, info } = await image.rotate().resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true }).webp({ quality: 92 }).toBuffer({ resolveWithObject: true });
      if (data.length > MAX_IMAGE_BYTES) throw new Error("encoded size");
      result.push({ name: original.name, data, mime_type: "image/webp", width: info.width, height: info.height });
    } catch {
      throw new DomainError(`无法读取图片“${original.name}”，请换一张有效图片（单边不超过 8192 像素，总像素不超过 4000 万）`);
    }
  }
  return result;
}

export function persistImages(messageId: number, images: PreparedImage[]): void {
  for (const image of images) run(
    "INSERT INTO message_images(id, message_id, name, mime_type, size, width, height, data) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
    randomUUID(), messageId, image.name, image.mime_type, image.data.length, image.width, image.height, image.data,
  );
}

export function messageImages(messageId: number, userId: string): ChatImage[] {
  return rows("SELECT id, name, mime_type, size, width, height FROM message_images WHERE message_id = ? ORDER BY rowid", messageId).map((image) => ({
    ...image, url: `/api/chat/images/${image.id}?user_id=${encodeURIComponent(userId)}`,
  })) as ChatImage[];
}

export function imageResponse(id: string, userId: string): Response {
  const image = one(`SELECT i.* FROM message_images i JOIN messages m ON m.id = i.message_id
    WHERE i.id = ? AND m.user_id = ? AND m.channel = 'web'`, id, userId);
  if (!image) throw new HttpError(404, "图片不存在或已删除");
  return new Response(new Uint8Array(image.data), { headers: {
    "Content-Type": image.mime_type, "Content-Length": String(image.size),
    "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
    "Content-Disposition": "inline",
  } });
}

export function imageData(images: PreparedImage[]): ModelImage[] {
  return images.map((image) => ({ data_url: `data:${image.mime_type};base64,${image.data.toString("base64")}` }));
}

export function modelHistory(userId: string, channel: string, currentImages: PreparedImage[]) {
  const history = rows("SELECT id, role, content, created_at FROM messages WHERE user_id = ? AND channel = ? ORDER BY id DESC LIMIT 12", userId, channel);
  let bytes = currentImages.reduce((sum, image) => sum + image.data.length, 0);
  let count = currentImages.length;
  return history.map((message) => {
    const images: ModelImage[] = [];
    let omitted = false;
    if (message.role === "user") {
      for (const meta of rows("SELECT id, size FROM message_images WHERE message_id = ? ORDER BY rowid", message.id)) {
        if (count >= 8 || bytes + Number(meta.size) > 20 * 1024 * 1024) { omitted = true; continue; }
        const data = one("SELECT data FROM message_images WHERE id = ?", meta.id)!.data;
        images.push({ data_url: `data:image/webp;base64,${Buffer.from(data).toString("base64")}` });
        count += 1; bytes += Number(meta.size);
      }
    }
    return { role: String(message.role), content: String(message.content) + (omitted ? "\n[较早的图片本轮未附上，如需查看请用户重发]" : ""), created_at: String(message.created_at), images };
  }).reverse();
}
