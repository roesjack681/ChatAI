import { chat } from "@core/conversation";
import { deepseek } from "@shared/config";

async function main() {
  const config = deepseek();
  if (!config.apiKey) throw new Error("DEEPSEEK_API_KEY is required");
  const started = Date.now();
  const result = await chat(
    "deepseek-smoke-user",
    "模型验收用户",
    "我今天有点累，刚把工作收尾。陪我简单聊两句，不要写动作旁白。",
    "smoke",
  );
  if (result.provider !== "deepseek") throw new Error(`expected deepseek provider, got ${result.provider}`);
  if (!result.reply.trim()) throw new Error("DeepSeek returned an empty reply");
  if (result.guard_violations.includes("narration_removed")) throw new Error("DeepSeek response contained narration");
  console.log(JSON.stringify({
    ok: true,
    provider: result.provider,
    model: config.model,
    duration_ms: Date.now() - started,
    reply: result.reply,
    trace_id: result.trace_id,
    hard_checks: result.hard_checks,
    guard_violations: result.guard_violations,
  }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
