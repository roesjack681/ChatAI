/**
 * QQ channel adapter.
 * It translates official QQ events into the conversation runtime.
 * It does not compile prompts or write the world ledger itself.
 */
import { createAggregator } from "@core/aggregate";

const API = "https://api.sgroup.qq.com";
const PUBLIC_MESSAGES = 1 << 25;

interface QqConfig {
  appId: string;
  secret: string;
  aggregateMs: number;
  gatewayUrl: string;
  integrationToken: string;
}

function config(): QqConfig {
  const appId = process.env.QQ_APP_ID?.trim() ?? "";
  const secret = process.env.QQ_APP_SECRET?.trim() ?? "";
  if (!appId || !secret) throw new Error("QQ_APP_ID and QQ_APP_SECRET are required");
  const integrationToken = process.env.HARNESS_INTEGRATION_TOKEN?.trim() ?? "";
  if (!integrationToken) throw new Error("HARNESS_INTEGRATION_TOKEN is required for QQ gateway access");
  const aggregateMs = Number(process.env.HARNESS_AGGREGATE_SECONDS ?? "0.8") * 1000;
  const gatewayUrl = (process.env.HARNESS_GATEWAY_URL?.trim() || "http://127.0.0.1:8000").replace(/\/$/, "");
  return { appId, secret, aggregateMs: Number.isFinite(aggregateMs) ? aggregateMs : 800, gatewayUrl, integrationToken };
}

async function companionReply(settings: QqConfig, channel: string, externalId: string, displayName: string, message: string): Promise<string> {
  const response = await fetch(`${settings.gatewayUrl}/api/integrations/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${settings.integrationToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ channel, external_user_id: externalId, display_name: displayName, message }),
  });
  const body = await response.json().catch(() => ({})) as { reply?: string; error?: string };
  if (!response.ok || !body.reply) throw new Error(body.error || `companion gateway failed: ${response.status}`);
  return body.reply;
}

async function accessToken(appId: string, secret: string): Promise<string> {
  const response = await fetch("https://bots.qq.com/app/getAppAccessToken", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appId, clientSecret: secret }),
  });
  if (!response.ok) throw new Error(`QQ token request failed: ${response.status}`);
  const body = (await response.json()) as { access_token?: string };
  if (!body.access_token) throw new Error("QQ token response did not include access_token");
  return body.access_token;
}

async function gatewayUrl(token: string): Promise<string> {
  const response = await fetch(`${API}/gateway`, { headers: { Authorization: `QQBot ${token}` } });
  if (!response.ok) throw new Error(`QQ gateway request failed: ${response.status}`);
  const body = (await response.json()) as { url?: string };
  if (!body.url) throw new Error("QQ gateway response did not include url");
  return body.url;
}

async function send(token: string, path: string, msgId: string, content: string): Promise<void> {
  const response = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { Authorization: `QQBot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ content, msg_type: 0, msg_id: msgId }),
  });
  if (!response.ok) throw new Error(`QQ send failed: ${response.status}`);
}

function textOf(payload: Record<string, unknown>): string {
  return String(payload.content ?? "").trim();
}

export async function runQq(): Promise<void> {
  const settings = config();
  const token = await accessToken(settings.appId, settings.secret);
  const url = await gatewayUrl(token);
  const aggregator = createAggregator(settings.aggregateMs, async (key, content) => {
    const [channel, externalId, displayName] = key.split("\u001f");
    return companionReply(settings, channel, externalId, displayName || "QQ 用户", content);
  });

  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url);
    let sequence: number | null = null;
    let heartbeat: ReturnType<typeof setInterval> | undefined;

    socket.addEventListener("open", () => undefined);
    socket.addEventListener("error", () => reject(new Error("QQ gateway socket failed")));
    socket.addEventListener("close", () => resolve());
    socket.addEventListener("message", (event) => {
      const packet = JSON.parse(String(event.data)) as { op: number; s?: number; t?: string; d?: Record<string, unknown> };
      if (typeof packet.s === "number") sequence = packet.s;
      if (packet.op === 10) {
        const interval = Number(packet.d?.heartbeat_interval ?? 40_000);
        socket.send(JSON.stringify({
          op: 2,
          d: {
            token: `QQBot ${token}`,
            intents: PUBLIC_MESSAGES,
            shard: [0, 1],
            properties: { $os: process.platform, $browser: "harness", $device: "harness" },
          },
        }));
        heartbeat = setInterval(() => socket.send(JSON.stringify({ op: 1, d: sequence })), interval);
        return;
      }
      if (packet.op !== 0 || !packet.d) return;
      void handleEvent(packet.t ?? "", packet.d).catch((error: unknown) => console.error(error));
    });

    async function handleEvent(type: string, data: Record<string, unknown>) {
      const content = textOf(data);
      if (!content) return;
      if (type === "C2C_MESSAGE_CREATE") {
        const author = data.author as { user_openid?: string } | undefined;
        const openid = author?.user_openid;
        if (!openid) return;
        const result = await aggregator(`qq\u001f${openid}\u001fQQ 用户`, content);
        if (result.leader) await send(token, `/v2/users/${openid}/messages`, String(data.id), result.reply);
        return;
      }
      if (type === "GROUP_AT_MESSAGE_CREATE") {
        const author = data.author as { member_openid?: string } | undefined;
        const openid = author?.member_openid;
        const group = String(data.group_openid ?? "");
        if (!openid || !group) return;
        const result = await aggregator(`qq-group\u001f${openid}\u001fQQ 用户`, content);
        if (result.leader) await send(token, `/v2/groups/${group}/messages`, String(data.id), result.reply);
      }
    }

    socket.addEventListener("close", () => {
      if (heartbeat) clearInterval(heartbeat);
    });
  });
}

const entry = process.argv[1]?.replaceAll("\\", "/");
if (entry?.endsWith("packages/channels/src/qq/main.ts")) {
  runQq().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
