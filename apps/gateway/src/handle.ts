import { adminToken, deepseek } from "@shared/config";
import { audit, one, rows, run } from "@infra/db";
import { DomainError, HttpError } from "@shared/errors";
import { isAdmin, isIntegration, safeEqual, sessionCookie } from "@shared/auth";
import { chat, deleteChatHistory } from "@core/conversation";
import { createConversation, listConversations } from "../../../packages/core/src/conversation/history";
import { imageResponse, messageImages } from "../../../packages/core/src/conversation/images";
import { MAX_CHAT_BODY_BYTES } from "@shared/images";
import { confirm } from "@people/commitments";
import { setGlobalMood, setState, current as emotionCurrent } from "@world/emotion";
import { receive, review as reviewExternal } from "@channels/external";
import { bind, createBindingCode, resolve } from "@people/identity";
import { enqueue, stats } from "@core/jobs";
import { forUser, forget, listMemories, remember, reviewCandidate } from "@memory";
import {refreshUserPortrait,userMemoryOverview} from "../../../packages/memory/src/portrait";
import { generate } from "@model";
import { profiles, recordEvent, upsertNpc } from "@world/npc";
import { getRelationship, relationshipEvents } from "@people/relationship";
import { createCandidate } from "@proactive";
import { activePrompt, catalog, compilePrompt, createBundle, publishBundle } from "@prompting";
import { runSimulation } from "@evaluation/simulation";
import { canProactivelyContact } from "@core/social";
import { advance, createGoal, listGoals } from "@world/stories";
import { active as activeCharacter, addGrowthEvidence, applyGrowth, createDraft as createCharacterDraft, growthEvidence, portrait, publish as publishCharacter, versions as characterVersions } from "@character";
import { getOrCreateUser, listUsers, requireUser } from "@people/users";
import { runOnce } from "@worker/loop";
import { addEvent, dailySummary, ensureDailySkeleton, events, saveScheduleTemplate, scheduleTemplates, updateStatus } from "@world/daily-life";
import { businessDate, hourNow, isoNow, shiftDate } from "@shared/time";
import { activeFacts, catalog as loreCatalog, proposeFact, reviewFact } from "@world/lore";
import { worldTree } from "../../../packages/world/src/lore/tree";

type Payload = Record<string, unknown>;
type Result = { body: unknown; status?: number; headers?: HeadersInit };

function str(value: unknown, fallback = ""): string {
  return value == null ? fallback : String(value);
}

function int(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...(headers as Record<string, string> | undefined) },
  });
}

async function readBody(request: Request, limit = 1_000_000): Promise<Payload> {
  if (Number(request.headers.get("content-length")) > limit) throw new HttpError(413, "请求内容过大");
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) { await reader.cancel(); throw new HttpError(413, "请求内容过大"); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
  }
  const raw = new TextDecoder().decode(Buffer.concat(chunks));
  if (!raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DomainError("invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new DomainError("JSON object required");
  return parsed as Payload;
}

function authorize(request: Request, path: string): void {
  if (path === "/integrations/events/review") {
    if (!isAdmin(request)) throw new HttpError(401, "admin authorization required");
    return;
  }
  if (path.startsWith("/integrations/")) {
    if (!isIntegration(request)) throw new HttpError(401, "integration authorization required");
    return;
  }
  if (!isAdmin(request)) {
    throw new HttpError(401, path === "/chat" ? "admin authorization required; user channel authentication is not configured" : "admin authorization required");
  }
}

function query(url: URL, key: string, fallback = ""): string {
  return url.searchParams.get(key) ?? fallback;
}

async function get(path: string, url: URL): Promise<unknown> {
  switch (path) {
    case "/session":
      return { ok: true };
    case "/dashboard": {
      const provider = deepseek().apiKey ? "DeepSeek" : "离线回退";
      return {
        users: Number(one("SELECT count(*) AS n FROM users")?.n ?? 0),
        messages_today: Number(one("SELECT count(*) AS n FROM messages WHERE substr(created_at, 1, 10) = ?", businessDate())?.n ?? 0),
        traces: Number(one("SELECT count(*) AS n FROM traces")?.n ?? 0),
        token_usage: Number(one("SELECT coalesce(sum(input_tokens + output_tokens), 0) AS n FROM traces")?.n ?? 0),
        provider,
        character: portrait(),
        today: businessDate(),
      };
    }
    case "/chat/history": {
      const userId = query(url, "user_id", "web-default");
      return { messages: rows("SELECT id, role, content, created_at, trace_id FROM messages WHERE user_id = ? AND channel = 'web' ORDER BY id DESC LIMIT 100", userId).reverse().map((message) => ({ ...message, images: messageImages(Number(message.id), userId) })) };
    }
    case "/users":
      return { users: listUsers() };
    case "/chat/conversations":
      return { conversations: listConversations() };
    case "/character":
      return { character: portrait(), mood: String(one("SELECT value FROM settings WHERE key = 'global_mood'")?.value ?? "") };
    case "/world/tree":
      return worldTree();
    case "/character/versions":
      return { active: activeCharacter(), versions: characterVersions() };
    case "/character/growth/evidence":
      return { items: growthEvidence(query(url, "attribute")) };
    case "/relationships": {
      const userId = query(url, "user_id");
      if (!requireUser(userId)) throw new HttpError(404, "user not found");
      return { relationship: getRelationship(userId), events: relationshipEvents(userId, 30) };
    }
    case "/world": {
      const day = query(url, "date", businessDate());
      return { date: day, events: events(day), goals: listGoals(), npcs: profiles(), summary: dailySummary(day) };
    }
    case "/world/lore":
      return { items: loreCatalog(query(url, "status")) };
    case "/memories": {
      const userId = query(url, "user_id", "web-default");
      return { user_id: userId, memories: listMemories(userId) };
    }
    case "/memory/overview":
      return userMemoryOverview(query(url,"user_id"));
    case "/traces":
      return { traces: rows("SELECT id, user_id, channel, created_at, duration_ms, provider, model, prompt_version, decision, memory_ids, response, input_tokens, output_tokens, status FROM traces ORDER BY created_at DESC LIMIT 100") };
    case "/traces/detail": {
      const trace = one("SELECT * FROM traces WHERE id = ?", query(url, "id"));
      if (!trace) throw new HttpError(404, "trace not found");
      return { trace };
    }
    case "/prompts":
      return catalog();
    case "/settings":
      return {
        timezone: "Asia/Shanghai",
        model: deepseek().model,
        provider: deepseek().apiKey ? "DeepSeek" : "离线回退",
        proactive_requires_opt_in: true,
        admin_auth_required: true,
        schema_version: one("SELECT max(version) AS version FROM schema_migrations")?.version ?? 1,
        immersive_mode: String(one("SELECT value FROM settings WHERE key = 'immersive_mode'")?.value ?? "true") === "true",
      };
    case "/jobs":
      return { stats: stats(), jobs: rows("SELECT * FROM jobs ORDER BY id DESC LIMIT 200") };
    case "/operations/health": {
      const now = Date.now();
      const workers = rows("SELECT * FROM worker_heartbeats ORDER BY last_seen_at DESC").map((worker) => {
        const ageSeconds = Math.max(0, Math.floor((now - new Date(String(worker.last_seen_at)).getTime()) / 1000));
        return { ...worker, age_seconds: ageSeconds, effective_status: ageSeconds > 90 ? "offline" : worker.status };
      });
      return {
        model: { configured: Boolean(deepseek().apiKey), provider: deepseek().apiKey ? "DeepSeek" : "offline-fallback", name: deepseek().model },
        workers,
        jobs: stats(),
        outbox: Object.fromEntries(rows("SELECT status, count(*) AS n FROM outbox GROUP BY status").map((item) => [String(item.status), Number(item.n)])),
        latest_trace: one("SELECT provider, model, status, created_at, duration_ms FROM traces ORDER BY created_at DESC LIMIT 1") ?? null,
        now: isoNow(),
      };
    }
    case "/outbox":
      return { items: rows("SELECT * FROM outbox ORDER BY id DESC LIMIT 200") };
    case "/commitments": {
      const userId = query(url, "user_id");
      return { items: rows("SELECT * FROM commitments WHERE (? = '' OR user_id = ?) ORDER BY id DESC LIMIT 200", userId, userId) };
    }
    case "/proactive/candidates":
      return { items: rows("SELECT * FROM proactive_candidates ORDER BY id DESC LIMIT 200") };
    case "/memory/candidates": {
      const userId = query(url, "user_id");
      return { items: rows("SELECT * FROM memory_candidates WHERE (? = '' OR user_id = ?) ORDER BY id DESC LIMIT 200", userId, userId) };
    }
    case "/stories":
      return { goals: listGoals(query(url,"include_archived") === "1") };
    case "/npcs":
      return { npcs: profiles() };
    case "/emotions":
      return emotionCurrent(query(url, "user_id") || null);
    case "/evaluations":
      return { items: rows("SELECT * FROM evaluations ORDER BY id DESC LIMIT 200") };
    case "/audit":
      return { items: rows("SELECT * FROM audit_log ORDER BY id DESC LIMIT 200") };
    case "/channels":
      return { channels: rows("SELECT channel, enabled, mode, capabilities, updated_at FROM channel_configs ORDER BY channel") };
    case "/external-events":
      return { items: rows("SELECT * FROM external_events ORDER BY id DESC LIMIT 100") };
    case "/schedules":
      return { items: scheduleTemplates() };
    default:
      throw new HttpError(404, "not found");
  }
}

async function post(path: string, data: Payload): Promise<Result> {
  switch (path) {
    case "/chat":
      return { body: await chat(str(data.user_id, "web-default"), str(data.display_name, "朋友"), str(data.message), str(data.channel, "web"), data.images) };
    case "/chat/conversations":
      return { status: 201, body: { conversation: createConversation(str(data.name)) } };
    case "/integrations/messages": {
      const externalId = str(data.external_user_id).trim().slice(0, 100);
      if (!externalId) throw new DomainError("external_user_id is required");
      const channel = str(data.channel, "external").slice(0, 40);
      const user = resolve(channel, externalId, str(data.display_name, "朋友"));
      return { body: await chat(user.id, str(data.display_name, "朋友"), str(data.message), channel) };
    }
    case "/integrations/events": {
      const externalId = str(data.external_id).trim().slice(0, 200);
      if (!externalId) throw new DomainError("external_id is required");
      const source = str(data.source, "external").slice(0, 80);
      const user = resolve(source, str(data.external_user_id), str(data.display_name, "朋友"));
      const result = receive({ source, externalId, userId: user.id, eventType: str(data.event_type, "activity"), payload: data.payload ?? {} });
      if ("duplicate" in result) return { body: result };
      return { status: 202, body: { ...result, note: "事件已登记，尚未自动写入长期记忆或共享世界" } };
    }
    case "/integrations/events/review":
      return { body: reviewExternal(int(data.id), str(data.decision), str(data.summary)) };
    case "/external-events/review":
      return { body: reviewExternal(int(data.id), str(data.decision), str(data.summary)) };
    case "/users":
      return { status: 201, body: { user: getOrCreateUser(str(data.id), str(data.display_name, "朋友")) } };
    case "/proactive/settings": {
      const userId = str(data.user_id);
      getOrCreateUser(userId, str(data.display_name, userId));
      const start = str(data.quiet_start, "22:00");
      const end = str(data.quiet_end, "08:00");
      if (!/^\d\d:\d\d$/.test(start) || !/^\d\d:\d\d$/.test(end)) throw new DomainError("免打扰时间格式须为 HH:MM");
      run("UPDATE users SET proactive_enabled = ?, quiet_start = ?, quiet_end = ? WHERE id = ?", data.enabled ? 1 : 0, start, end, userId);
      audit("proactive_settings", { user_id: userId, enabled: Boolean(data.enabled) });
      return { body: { ok: true } };
    }
    case "/settings/mood":
      setGlobalMood(str(data.mood));
      audit("global_mood_updated", { mood: str(data.mood).trim() });
      return { body: { ok: true } };
    case "/settings/immersive": {
      const enabled = Boolean(data.enabled);
      run(
        `INSERT INTO settings(key, value, updated_at) VALUES('immersive_mode', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        enabled ? "true" : "false", isoNow(),
      );
      audit("immersive_mode_updated", { enabled });
      return { body: { ok: true, immersive_mode: enabled } };
    }
    case "/character/drafts": {
      const profile = data.profile && typeof data.profile === "object" && !Array.isArray(data.profile)
        ? data.profile as Record<string, unknown>
        : {};
      const id = createCharacterDraft(str(data.name, "角色档案草稿"), profile, "admin");
      audit("character_draft_created", { version_id: id });
      return { status: 201, body: { id } };
    }
    case "/character/publish":
      return { body: { character: publishCharacter(int(data.id)) } };
    case "/character/growth/evidence":
      return { status: 201, body: { id: addGrowthEvidence(str(data.attribute), str(data.proposed_value), str(data.evidence_date), str(data.summary), data.source_event_id == null ? null : int(data.source_event_id)) } };
    case "/character/growth/apply":
      return { status: 201, body: { version_id: applyGrowth(str(data.attribute), str(data.proposed_value), "admin") } };
    case "/emotions":
      return { status: 201, body: { id: setState(str(data.scope, "global"), str(data.mood, "calm"), str(data.reason), data.user_id == null ? null : str(data.user_id)) } };
    case "/world/events": {
      const id = addEvent({
        title: str(data.title),
        details: str(data.details),
        day: data.date == null ? null : str(data.date),
        startTime: data.start_time == null ? null : str(data.start_time),
        endTime: data.end_time == null ? null : str(data.end_time),
        status: str(data.status, "planned"),
        shareLevel: str(data.share_level, "public"),
        userId: data.user_id == null ? null : str(data.user_id),
        source: "admin",
      });
      audit("world_event_created", { event_id: id, title: data.title });
      return { status: 201, body: { id } };
    }
    case "/world/events/status": {
      const ok = updateStatus(int(data.id), str(data.status));
      if (!ok) throw new HttpError(404, "event not found");
      return { body: { ok } };
    }
    case "/world/lore":
      return { status: 201, body: proposeFact({ subject: str(data.subject), predicate: str(data.predicate), object: str(data.object), scope: str(data.scope, "global"), source: "admin", confidence: Number(data.confidence ?? 1) }) };
    case "/world/lore/review":
      return { body: { fact: reviewFact(int(data.id), Boolean(data.accept)) } };
    case "/schedules": {
      const id = saveScheduleTemplate({
        id: data.id == null ? null : int(data.id),
        weekday: data.weekday == null || data.weekday === "" ? null : int(data.weekday),
        startTime: str(data.start_time),
        endTime: data.end_time == null || data.end_time === "" ? null : str(data.end_time),
        title: str(data.title),
        details: str(data.details),
        category: str(data.category, "routine"),
        probability: data.probability == null ? 1 : Number(data.probability),
        enabled: data.enabled !== false,
      });
      audit("schedule_template_saved", { id });
      return { status: data.id == null ? 201 : 200, body: { id } };
    }
    case "/goals":
      return { status: 201, body: { id: createGoal(str(data.title), str(data.description), str(data.status, "active"), Number(data.progress ?? 0), {stage:data.stage == null ? undefined : str(data.stage),obstacle:str(data.obstacle),next_action:str(data.next_action),milestones:data.milestones as string[] | undefined}) } };
    case "/stories/advance":
      return { body: { goal: advance(int(data.goal_id), str(data.summary), Number(data.delta ?? 0), str(data.kind, "progress"), data.source_event_id == null ? null : int(data.source_event_id)) } };
    case "/npcs":
      upsertNpc(str(data.name), str(data.profile), str(data.relationship, "friend"));
      return { status: 201, body: { ok: true } };
    case "/npcs/events":
      return { status: 201, body: { id: recordEvent(int(data.npc_id), str(data.summary), Number(data.relationship_delta ?? 0), data.source_event_id == null ? null : int(data.source_event_id)) } };
    case "/memories": {
      const userId = str(data.user_id);
      const id = remember(userId, str(data.text), str(data.kind, "fact"), int(data.importance, 3));
      audit("memory_created", { user_id: userId, memory_id: id });
      return { status: 201, body: { id } };
    }
    case "/memory/portrait":
      return {body:await refreshUserPortrait(str(data.user_id))};
    case "/memories/delete": {
      const ok = forget(str(data.user_id), int(data.id));
      audit("memory_deleted", { user_id: data.user_id, id: data.id });
      if (!ok) throw new HttpError(404, "memory not found");
      return { body: { ok } };
    }
    case "/memory/candidates/review": {
      const result = reviewCandidate(int(data.id), Boolean(data.accept), "admin");
      audit("memory_candidate_reviewed", result);
      return { body: result };
    }
    case "/prompts": {
      const modules = (data.modules && typeof data.modules === "object" ? data.modules : {}) as Record<string, string>;
      const version = createBundle(str(data.name, "Prompt 草稿"), modules);
      audit("prompt_draft_created", { version });
      return { status: 201, body: { version } };
    }
    case "/prompts/publish":
      return { body: { ok: true, prompt: publishBundle(int(data.version)) } };
    case "/sandbox/simulate": {
      const days = Math.max(1, Math.min(int(data.days, 7), 30));
      const start = str(data.start_date, businessDate());
      const dates = Array.from({ length: days }, (_, offset) => {
        const day = shiftDate(start, offset);
        ensureDailySkeleton(day, "sandbox");
        return day;
      });
      const eventsCreated = Number(one(
        "SELECT count(*) AS n FROM world_events WHERE environment = 'sandbox' AND event_date BETWEEN ? AND ?",
        dates[0],
        dates[dates.length - 1],
      )?.n ?? 0);
      return { body: { days: dates, environment: "sandbox", events_created: eventsCreated } };
    }
    case "/proactive/preview": {
      const user = requireUser(str(data.user_id, "web-default"));
      if (!user) return { body: { allowed: false, reason: "用户不存在" } };
      const decision = canProactivelyContact(user, hourNow(), Boolean(data.unanswered));
      const channels = rows("SELECT channel, capabilities, mode, enabled FROM channel_configs");
      return { body: { allowed: decision.allowed, reason: decision.reason, channel_capabilities: Object.fromEntries(channels.map((channel) => [channel.channel, channel])) } };
    }
    case "/proactive/candidates":
      return { status: 201, body: { id: createCandidate(str(data.user_id), str(data.topic), str(data.reason, "admin"), str(data.source_type, "admin"), data.source_id == null ? null : int(data.source_id), int(data.delay_minutes), int(data.ttl_hours, 8)) } };
    case "/commitments/confirm":
      return { body: { commitment: confirm(int(data.id), str(data.due_at)) } };
    case "/jobs":
      return { status: 201, body: { id: enqueue(str(data.kind), (data.payload as Record<string, unknown>) ?? {}, data.run_at == null ? null : str(data.run_at), data.dedupe_key == null ? null : str(data.dedupe_key), int(data.max_attempts, 3)) } };
    case "/jobs/run-once":
      return { body: { result: await runOnce() } };
    case "/channels": {
      const channel = str(data.channel).trim().slice(0, 40);
      if (!channel) throw new DomainError("channel is required");
      run(
        `INSERT INTO channel_configs(channel, enabled, mode, capabilities, config, updated_at) VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel) DO UPDATE SET enabled = excluded.enabled, mode = excluded.mode, capabilities = excluded.capabilities, config = excluded.config, updated_at = excluded.updated_at`,
        channel,
        data.enabled ? 1 : 0,
        str(data.mode, "sync"),
        JSON.stringify(data.capabilities ?? {}),
        JSON.stringify(data.config ?? {}),
        isoNow(),
      );
      audit("channel_configured", { channel, enabled: Boolean(data.enabled) });
      return { body: { ok: true } };
    }
    case "/identities/binding-code":
      return { status: 201, body: { code: createBindingCode(str(data.user_id), int(data.ttl_minutes, 10)) } };
    case "/identities/bind": {
      const userId = bind(str(data.code), str(data.channel), str(data.external_id));
      audit("identity_bound", { user_id: userId, channel: data.channel });
      return { body: { user_id: userId } };
    }
    case "/evaluate/compare": {
      const message = str(data.message);
      if (!message) throw new DomainError("message is required");
      const user = getOrCreateUser(str(data.user_id, "web-default"), "A/B 测试用户");
      const active = activePrompt();
      const memories = forUser(user.id, message);
      const facts = events(undefined, user.id);
      const mood = String(one("SELECT value FROM settings WHERE key = 'global_mood'")?.value ?? "平静");
      const worldFacts = activeFacts(80);
      const base = compilePrompt({ user, memories, events: facts, worldFacts, mood, userMessage: message });
      const candidate = compilePrompt({ user, memories, events: facts, worldFacts, mood, userMessage: message, promptOverride: str(data.candidate, active.content) });
      const left = await generate(base.system, [], message);
      const right = await generate(candidate.system, [], message);
      return {
        body: {
          active_version: base.version,
          active: left.content,
          candidate: right.content,
          same_input: message,
          isolated_user: user.id,
          memory_ids: memories.map((item) => item.id),
          world_event_ids: facts.map((item) => item.id),
        },
      };
    }
    case "/evaluate/long-run":
      return { body: runSimulation(int(data.days, 7), data.start_date == null ? null : str(data.start_date)) };
    default:
      throw new HttpError(404, "not found");
  }
}

function failure(error: unknown): Response {
  if (error instanceof HttpError) return json({ error: error.message }, error.status);
  if (error instanceof DomainError || error instanceof SyntaxError) return json({ error: error.message }, 400);
  console.error(error);
  return json({ error: "internal server error" }, 500);
}

export async function handle(request: Request, segments: string[]): Promise<Response> {
  const path = `/${segments.join("/")}`;
  try {
    if (request.method === "GET" && path === "/health") {
      return json({ ok: true, time: isoNow(), timezone: "Asia/Shanghai" });
    }
    if (request.method === "POST" && path === "/session") {
      const data = await readBody(request);
      if (!safeEqual(str(data.token), adminToken())) throw new HttpError(401, "admin authorization required");
      return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(adminToken(), 60 * 60 * 24 * 14) });
    }
    if (request.method === "DELETE" && path === "/session") {
      return json({ ok: true }, 200, { "Set-Cookie": sessionCookie("", 0) });
    }
    authorize(request, path);
    if (request.method === "GET" && /^\/chat\/images\/[a-f0-9-]{36}$/u.test(path)) {
      return imageResponse(segments[2], query(new URL(request.url), "user_id"));
    }
    if (request.method === "GET") return json(await get(path, new URL(request.url)));
    if (request.method === "DELETE" && (path === "/chat/history" || path === "/chat/conversations")) {
      const userId = query(new URL(request.url), "user_id").trim();
      if (!userId) throw new DomainError("user_id is required");
      return json(await deleteChatHistory(userId, path === "/chat/conversations"));
    }
    if (request.method === "POST") {
      const result = await post(path, await readBody(request, path === "/chat" ? MAX_CHAT_BODY_BYTES : 1_000_000));
      return json(result.body, result.status ?? 200, result.headers);
    }
    throw new HttpError(405, "method not allowed");
  } catch (error) {
    return failure(error);
  }
}
