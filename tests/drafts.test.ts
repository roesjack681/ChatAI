import assert from "node:assert/strict";
import { test } from "node:test";

import { replyCandidates } from "../packages/core/src/conversation/drafts";
import { generate } from "@model";

test("candidate parsing never lets malformed internal JSON leak into chat", () => {
  assert.deepEqual(replyCandidates('```json\n{"replies":["  你好 ","嗨","你好"]}\n```', true), ["你好", "嗨"]);
  assert.deepEqual(replyCandidates('候选：{"replies":["你好"]}', true), ["你好"]);
  assert.deepEqual(replyCandidates("你好呀。", true), ["你好呀。"]);
  for (const content of ['{"replies":[]}', '{"replies":[""]}', '{"replies":[1]}', '{"reply":"你好"}', '```json\n{"replies":']) {
    assert.throws(() => replyCandidates(content, true), /invalid reply candidates/);
  }
  assert.deepEqual(replyCandidates('{"replies":[]}', false), ['{"replies":[]}']);
});

test("a blank structured response is retried once without losing reported usage", async (t) => {
  process.env.DEEPSEEK_API_KEY = "structured-test-key";
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return Response.json({ choices: [{ message: { content: calls === 1 ? "   " : '{"replies":["你好"]}' }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  });
  const result = await generate('只输出JSON：{"replies":["回复"]}', [], "你好", [], { json: true });
  assert.equal(calls, 2);
  assert.equal(result.usage.input_tokens, 20);
  assert.equal(result.usage.output_tokens, 10);
  assert.deepEqual(replyCandidates(result.content, true), ["你好"]);
});
