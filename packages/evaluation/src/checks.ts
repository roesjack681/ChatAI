import { run } from "@infra/db";
import { isoNow } from "@shared/time";

export function hardChecks(output: string) {
  const lower = output.toLowerCase();
  return {
    no_narration: !/[（(\[].*(微笑|叹气|旁白|动作|沉默).*[）)\]]/.test(output),
    reasonable_length: output.length <= 800,
    no_fake_human_claim: !["我是一个真实的人", "我不是AI，我是人类"].some((phrase) => output.includes(phrase)),
    no_system_leak: !["system prompt", "系统提示词是", "prompt 里", "数据库里", "账本里", "生活账本"].some((phrase) => lower.includes(phrase)),
    no_canned_reply: !["嗯嗯，我听着呢", "你愿意多说一点吗", "我理解你的感受", "感谢你的分享"].some((phrase) => output.includes(phrase)),
  };
}

export function record(suite: string, caseName: string, input: string, output: string, promptVersion: number | null = null, contextualChecks: Record<string, boolean> = {}) {
  const checks: ReturnType<typeof hardChecks> & Record<string, boolean> = { ...hardChecks(output), ...contextualChecks };
  const values = Object.values(checks);
  const score = values.reduce((sum, passed) => sum + (passed ? 1 : 0), 0) / values.length;
  const passed = values.every(Boolean);
  const created = run(
    `INSERT INTO evaluations(suite, case_name, prompt_version, input, output, checks, score, passed, created_at)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    suite,
    caseName,
    promptVersion,
    input,
    output,
    JSON.stringify(checks),
    score,
    passed ? 1 : 0,
    isoNow(),
  );
  return { id: created.lastId, checks, score, passed };
}
