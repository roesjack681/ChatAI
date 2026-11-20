# 部署

生产环境必须设置强随机 `HARNESS_ADMIN_TOKEN`。集成渠道另设 `HARNESS_INTEGRATION_TOKEN`。DeepSeek 和 QQ 凭证都只放在环境变量里。

`docker compose up --build -d` 启动 Web 和 Worker，数据在 `harness_data` 卷。Web 健康检查是 `/api/health`。

QQ 使用 profile：`docker compose --profile qq up --build -d`。适配器只负责 QQ 协议和消息聚合，通过带 `HARNESS_INTEGRATION_TOKEN` 的 HTTP 请求调用 Web 网关；它不挂载数据卷、不开数据库，也不能绕过网关修改世界事实。
