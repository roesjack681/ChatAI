# API

用户记忆与特征总结新增 `GET /api/memory/overview?user_id=...` 和 `POST /api/memory/portrait`（正文`{user_id}`），均需管理员授权。前者返回分类记忆、待确认候选、带依据的模型总结、关系和处理统计；后者只基于该用户资料生成并核对依据。来源更正/删除后总结失效，生成期间内容改变返回409；模型失败不覆盖旧结果。详情见 [用户记忆说明](USER_MEMORY.md)。

`/api/health` 公开。`POST /api/session` 用管理员令牌换 HttpOnly Cookie。其余管理接口接受该 Cookie，或 `Authorization: Bearer <HARNESS_ADMIN_TOKEN>`。

集成接口使用 `HARNESS_INTEGRATION_TOKEN`：

- `POST /api/integrations/messages`
- `POST /api/integrations/events`

事件审核是管理员能力，集成令牌不能调用：

- `GET /api/external-events`
- `POST /api/external-events/review`

角色版本与成长：

- `GET /api/character/versions`
- `POST /api/character/drafts`
- `POST /api/character/publish`
- `GET|POST /api/character/growth/evidence`
- `POST /api/character/growth/apply`

角色档案可包含 `life_experiences` 与 `relationship_network`，与身份字段一起保存草稿、发布和保留版本。前者为 `{id, age_start, age_end, period, title, event, impact, people: string[], keywords: string[]}` 列表，后者为 `{from, to, relation, closeness, interaction, boundary}` 列表；限制各40条，验证年龄范围、必填字段及重复编号/关系。它们描述同一角色的固定背景，不能作为用户的私有记忆或实时完成事件。

`GET /api/world/tree` 返回 `{tree, summary}`，将当前角色、成长经历、关系网、公开世界事实、亲友、目标、日程模板及基础情绪组合成世界树。它是管理接口，需要管理员会话；不包含真实用户私有记忆。

角色档案支持字符串字段 `knowledge_familiar`（熟悉的领域）和 `knowledge_unfamiliar`（不熟悉的领域），沿用角色草稿/发布版本流程。未配置时只依据已确认职业与日常常识给出保守默认范围；聊天内容或图片不会自行扩充全局角色的专业能力。当前回复的认知越界检查由 `hard_checks.role_knowledge_boundary` 与 `knowledge_issues` 返回。

`relationship_status`（感情状态）和 `social_style`（相处方式）同样通过角色版本编辑。文字聊天返回 `dialogue_rewrites`、`dialogue_issues`、`semantic_issues`、`semantic_review_status`（`checked` / `not_needed` / `unavailable`），以及 `hard_checks.natural_turn_flow`、`hard_checks.contextual_reply`。复核不可用不等于检查通过。

`candidate_count` 是最终起草轮次的候选数。短闲聊可比较多个接法，只返回并保存选中的一条正文；候选不作为多条消息发送。明确多余的独立句尾追问被删除时，`guard_violations` 包含 `unneeded_followup_removed`。

聊天还返回 `capability_issues`、`hard_checks.executable_commitments` 和 `request_contract: { action, requested_detail, repair_needed }`。`action` 可为 `game_session`、`contact_exchange`、`meeting`、`call`、`self_photo`、`location`、`reminder`、`external_operation` 或 `null`；识别到旧承诺时会要求纠正。纯文字追踪的 `decision` 对应 `answer_<action>` 或 `repair_<action>`，图文沿用 `vision_conversation`。这些字段用于诊断，不能作为实际执行成功的凭证。

当前没有游戏客户端、可添加的角色账号、线下会面、通话、自拍、实时定位或代下单通道。生成候选和最终正文均检查这些限制，普通暧昧、假设故事和成语接龙仍可正常聊天。歌名、书名追问要求具体名称，并延续同一作品；相关旧消息按用户与渠道从完整历史中检索，清空历史后不再召回被删消息。

已配置模型时，服务商错误、超时、回复因预算耗尽被截断或两次重写后仍有明确接话问题会返回 502，前端保留输入供重试，不生成固定替代回复。失败轮次不新增消息、记忆或提醒，也不增加关系互动；未配置密钥时的离线开发模式由健康接口明确标示。

模型首次生成返回 402 时，502 错误正文明确说明账户余额不足；401/403 明确说明服务端模型鉴权失败，不输出密钥或提供方原始正文。健康接口的 `configured` 仅表示已配置密钥，不保证账户额度可用。

生活日程：

- `GET|POST /api/schedules`

共享世界设定：

- `GET|POST /api/world/lore`
- `POST /api/world/lore/review`

世界事实始终先成为提案；如果与当前已确认事实的 `(scope, subject, predicate)` 相同但值不同，会记录冲突关系，审核接受后才会替换旧事实。

其他管理资源：`/api/chat`、`/api/users`、`/api/memories`、`/api/world`、`/api/stories`、`/api/npcs`、`/api/prompts`、`/api/jobs`、`/api/outbox`、`/api/evaluate/compare`、`/api/evaluate/long-run`。

聊天记录管理（管理员鉴权）：

`POST /api/chat` 支持图文或纯图片：`{ "user_id": "...", "message": "看看这张图", "images": [{ "name": "photo.png", "data_url": "data:image/png;base64,..." }] }`。`message` 可留空，但文字与图片不能同时为空。最多 4 张，每张原文件不超过 5 MiB，总计不超过 12 MiB；接受 JPEG、PNG、WebP、GIF（GIF 使用首帧）。服务端按真实图片内容解码校验，纠正方向、缩放至最长边 2048、去除元数据并转为 WebP 后保存及发送模型。超大请求体返回 413，损坏或不支持的图片返回 400。

历史消息的 `images` 返回元数据和需管理员鉴权的 `GET /api/chat/images/:id?user_id=...` 地址，不直接返回 base64。消息内图片以数据库 BLOB 保存，清空消息或删除聊天时自动级联清理。最近消息的图片会随后续追问发送模型，单次模型请求最多保留 8 张、20 MiB，优先保留当前消息和较新的图片。图片及图中文字不会自行写入长期记忆。识图请求失败返回 502，不写入失败轮次的消息或假回复，前端保留输入供重试。

- `GET /api/chat/conversations`：返回 Web 聊天列表、最后消息预览和消息数，按更新时间排序。
- `POST /api/chat/conversations`：`{ "name": "聊天名称" }` 创建聊天，无需填写用户 ID。
- `DELETE /api/chat/history?user_id=...`：清空该 Web 聊天消息和对应追踪，保留列表入口。
- `DELETE /api/chat/conversations?user_id=...`：删除消息、对应追踪及列表入口。

删除不会移除长期记忆、关系、提醒或其他渠道消息；关联消息证据会解除引用。删除与同一 Web 聊天的回复按顺序执行，避免生成中的回复重新出现在已删除的聊天中。schema 7 仅首次迁移已有 Web 消息到聊天列表，纯渠道用户和未聊天的测试身份不再混入侧栏。

运行健康状态使用 `GET /api/operations/health`，返回模型配置、Worker 心跳及有效状态、任务统计、Outbox 统计和最近一次模型追踪。超过 90 秒没有心跳的 Worker 显示为 `offline`。

提醒确认沿用 `POST /api/commitments/confirm`，请求为 `{ "id": 123, "due_at": "2026-11-16T08:00:00+08:00" }`。确认前检查实际接收渠道是否启用、模式是否为 `webhook` 且配置有效 HTTP(S) 地址；同步或未配置渠道会拒绝确认，记录保留 `proposed`。目的渠道与 Worker 一致，使用用户首个绑定渠道，无绑定时为 `web`。有效配置不代表已投递成功，后续结果仍以 Outbox 为准。聊天区分未确认、`pending`、`queued` 和已投递完成状态，不凭口头答应报告已设置。

`due_at` 必须是带 `Z` 或显式时区偏移的有效 ISO 日期时间，拒绝无时区日期、无效日历日期及 `24:00`；保存时归一为北京时间。到期判定兼容已有 UTC/其他偏移记录。“提醒设好了吗”“你提醒我了吗”等查询读取实际状态，不创建新的提醒候选。

Outbox 增加运行状态 `sending`，表示已有任务占用该条消息；`lock_token` 和 `locked_at` 是内部调度字段。发送、重试和超时恢复均保留原有 `idempotency_key`，Webhook 接收方应按此键去重，处理网络超时或进程退出后远端结果未知的情况。

全局沉浸模式可通过 `POST /api/settings/immersive` 设置 `{ "enabled": true }`，状态由 `GET /api/settings` 的 `immersive_mode` 返回。该设置是系统级的，对所有用户和渠道生效。

错误统一是 `{"error":"..."}`。外部事件按 `(source, external_id)` 去重，投递按 `idempotency_key` 去重。
