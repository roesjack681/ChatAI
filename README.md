# 灵智AI

固定角色、按用户隔离记忆、共享生活世界的长期陪聊。界面和接口都在 Next.js 里，后台任务是独立进程。QQ 只做协议转换，不碰数据库。

## 本地

需要 Node.js 22。

```powershell
Copy-Item .env.example .env
npm install
npm run dev
```

另开一个终端：

```powershell
npm run worker
```

QQ 适配器是 TypeScript 进程，配置 `QQ_APP_ID` 和 `QQ_APP_SECRET` 后执行 `npm run qq`。

打开 <http://127.0.0.1:8000>，用 `HARNESS_ADMIN_TOKEN` 登录。未配置 `DEEPSEEK_API_KEY` 时走离线回复，流程仍然完整。

验证真实 DeepSeek 链路：

```powershell
$env:DEEPSEEK_API_KEY = "你的测试密钥"
npm run test:deepseek
```

## 验证

用户的已确认记忆、待确认内容和带原话依据的特征总结，可在聊天顶部或侧栏的“记忆与画像”查看。后台按对话增量自动整理，也可立即更新；说明与接口见 [用户记忆](docs/USER_MEMORY.md)。`npm run test:portrait`验证真实模型的短句记忆、用户隔离、依据核对、自动更新及删除后不恢复。

当前固定角色的55项资料、成长经历、家庭朋友关系网、目标、世界树与提示词见 [资料补全说明](docs/DATA_COMPLETENESS.md) 和 [完整当前配置](docs/CURRENT_CHARACTER.md)。已有数据库可先执行 `npm run data:complete` 预览，再用 `npm run data:complete -- --apply` 备份并补全；测试会话使用隔离数据库。

```powershell
npm test
npm run typecheck
npm run build
npm run test:character
```

`npm run test:social` 使用当前 Flash 模型、公开角色和当日公共日程，在隔离数据库运行 9 组、45 轮私聊回归；全部通过后可用 `npm run test:social -- --publish` 发布全局聊天规则。更多场景与诊断字段见 [测试说明](docs/TESTING.md)。

`npm run test:contracts` 在隔离数据库运行 10 组、41 轮真实模型回归，覆盖游戏邀约、旧承诺纠正、联系方式、见面、通话、照片、定位、提醒、具体作品名称、长历史回忆与普通社交。通过后用 `npm run test:contracts -- --publish` 发布能力与具体回答模块，保留角色档案和其他聊天模块。

`npm run test:reliability` 使用当前公开角色和 Prompt，在隔离数据库运行 4 组、13 轮真实模型回归，检查记忆提问不写成事实、用户经历不会被误改、已确认提醒查询及超过 100 条记忆后的检索。不发布 Prompt，也不发送外部通知。

`npm run test:everyday` 在隔离数据库运行 21 组、60 轮日常聊天回归，覆盖吐槽与建议切换、好消息、纠正、人物指代、离开回来、称呼更新、长聊后的宠物/室友回忆、变化后的口味、反话、跨天/跨周时间及连续多图指代。可用 `-- --case=nickname` 定位单组，或用逗号指定多组；额度或鉴权错误会中断后续场景，未跑完不能算通过。

`npm run test:agency` 在隔离数据库验证6组28轮双向相处：直接辱骂、催促已有拒绝、道歉后缓和、正常背诗、第三方倾诉与名字确认。通过后 `-- --publish` 仅追加语气和相处规则，保留身份模块。详见 [双向相处说明](docs/AGENCY_BEHAVIOR.md)。

## Docker

```powershell
docker compose up --build -d
```

QQ 适配器：

```powershell
docker compose --profile qq up --build -d
```

## 边界

- 管理接口认管理员 Cookie 或 Bearer 令牌。渠道用户不能靠猜用户 ID 登录。
- 集成接口使用单独的 `HARNESS_INTEGRATION_TOKEN`，身份按渠道加外部 ID 隔离。
- 模型输出不能改世界账本。明确偏好会进入该用户的私有记忆；普通闲聊不会自动变成长期事实。
- 主动消息默认关闭。同步渠道不会被写成已投递。
