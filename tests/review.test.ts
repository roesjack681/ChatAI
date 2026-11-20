import assert from "node:assert/strict";
import { test } from "node:test";

process.env.DEEPSEEK_API_KEY = "review-test-key";
process.env.DEEPSEEK_MODEL = "deepseek-flash";

test("contextual review sends known facts, not assistant claims as established biography", async (t) => {
  const requests: any[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, options: RequestInit) => {
    requests.push(JSON.parse(String(options.body)));
    return Response.json({ choices: [{ message: { content: JSON.stringify({ issues: ["角色仍在读大学，食堂经历没有依据"] }) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  });
  const { reviewDraft } = await import("../packages/core/src/conversation/review");
  const result = await reviewDraft({ message: "只能吃食堂", history: [{ role: "assistant", content: "我上学那会全靠二食堂" }], reply: "我上学那会儿也这样", character: { age: 21, occupation: "大学生" }, facts: [], casual: false });
  assert.equal(result.status, "checked");
  assert.equal(result.issues.length, 1);
  assert.equal(result.inputTokens, 10);
  assert.equal(requests[0].thinking.type, "enabled");
  const payload = JSON.parse(requests[0].messages.at(-1).content);
  assert.deepEqual(payload.confirmed_facts, []);
  assert.equal(payload.character.occupation, "大学生");
});

test("review errors are reported as unavailable rather than silently passing", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls += 1; return Response.json({ choices: [{ message: { content: "not json" } }] }); });
  const { reviewDraft } = await import("../packages/core/src/conversation/review");
  const result = await reviewDraft({ message: "好吧", history: [], reply: "今天天气不错", character: {}, facts: [], casual: true });
  assert.equal(result.status, "unavailable");
  assert.equal(calls, 2);
});

test("one transient malformed review can recover and both successful responses are counted", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return Response.json({ choices: [{ message: { content: calls === 1 ? "not json" : '{"issues":[]}' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  });
  const { reviewDraft } = await import("../packages/core/src/conversation/review");
  const result = await reviewDraft({ message: "没事干", history: [], reply: "那陪我闲一会儿", character: {}, facts: [], casual: true });
  assert.equal(result.status, "checked");
  assert.equal(calls, 2);
  assert.equal(result.inputTokens, 20);
  assert.equal(result.outputTokens, 10);
});

test("a comparison without a valid selected index cannot silently pass", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls += 1; return Response.json({ choices: [{ message: { content: '{"issues":[]}' } }] }); });
  const { reviewDraft } = await import("../packages/core/src/conversation/review");
  const result = await reviewDraft({ message: "没事干", history: [], reply: "那就闲着呗", candidates: ["那就闲着呗", "陪我说两句"], character: {}, facts: [], casual: true });
  assert.equal(result.status, "unavailable");
  assert.equal(result.selectedReply, undefined);
  assert.equal(calls, 2);
});
