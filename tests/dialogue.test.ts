import assert from "node:assert/strict";
import { test } from "node:test";

import { hasConversationalQuestion, planDialogue, reviewDialogue, trimUnneededFollowup } from "../packages/prompting/src/dialogue";
import { decideReply } from "@core/social";

test("casual replies distinguish greetings, activity questions, and answers to a question", () => {
  const history = [{ role: "assistant", content: "你今天忙不忙？" }];
  for (const greeting of ["你好", "你好呀！", "嗨", "在吗？"]) {
    const plan = planDialogue(greeting, []);
    assert.equal(plan.intent, "greeting");
    assert.equal(plan.useLifeContext, "background_only");
    assert.equal(plan.maxQuestions, 0);
  }
  for (const question of ["你在干嘛", "你在干什么？", "你在做什么", "忙啥呢", "在干嘛呢", "在做什么呢", "这会儿忙啥", "干啥呢"]) {
    assert.equal(planDialogue(question, history).useLifeContext, "answer_current_activity");
    assert.equal(decideReply(question, history), "answer_activity");
  }
  const answer = planDialogue("还好", history);
  assert.equal(answer.respondingToQuestion, true);
  assert.equal(answer.maxQuestions, 0);
  assert.equal(answer.useLifeContext, "background_only");
  for (const acknowledgement of ["好哦", "好嘞", "嗯哼", "行呗", "行叭"]) {
    assert.equal(planDialogue(acknowledgement, history).intent, "acknowledgement");
    assert.equal(planDialogue(acknowledgement, history).maxQuestions, 0);
  }
});

test("unwanted appended questions can be removed without regenerating a correct answer", () => {
  assert.equal(trimUnneededFollowup("你有对象吗", [], "没有啊。你呢？"), "没有啊。");
  assert.equal(trimUnneededFollowup("好吧", [], "那就聊着呗，今天过得怎么样"), "那就聊着呗。");
  assert.equal(trimUnneededFollowup("你有对象吗", [], "你问这个干嘛？"), "你问这个干嘛？");
  assert.equal(trimUnneededFollowup("怎么安排工作？", [], "先排优先级。你现在最急的是哪件？"), "先排优先级。你现在最急的是哪件？");
});

test("boredom and feedback about unnatural speech keep the focus on this conversation", () => {
  for (const message of ["没事干", "我现在没啥事", "无聊啊", "闲得慌", "没干啥"]) {
    const plan = planDialogue(message, []);
    assert.equal(plan.intent, "idle", message);
    assert.equal(plan.useLifeContext, "background_only");
  }
  for (const message of ["你咋这么像ai", "这也很ai啊", "你说话好官方", "说人话", "正常点说话"]) {
    assert.equal(planDialogue(message, []).intent, "style_feedback", message);
    assert.equal(planDialogue(message, []).maxQuestions, 0);
  }
  assert.notEqual(planDialogue("你是AI吗", []).intent, "style_feedback");
  assert.notEqual(planDialogue("机器人是怎么工作的？", []).intent, "style_feedback");
  assert.ok(reviewDialogue("你好", [], "你好呀，很高兴认识你。").length);
  assert.ok(reviewDialogue("你咋这么像ai", [], "哈哈，是有点太客气了吗？其实我就是随口招呼，想聊点啥都行。").length);
  for (const reply of ["好吧，那我改改，说话随便点，你别在意啊。", "我正常点说话。", "以后我注意表达方式。", "被你抓包了。", "我重新来一句。"]) assert.ok(reviewDialogue("这也很ai啊", [], reply).length, reply);
  assert.equal(reviewDialogue("你咋这么像ai", [], "那句说得我自己都尴尬。").length, 0);
});

test("new details and substantive questions are not treated as empty acknowledgements", () => {
  for (const message of ["还好，我刚到家，刚才差点坐过站", "你好，我想和你商量件事", "你觉得我该不该换工作？", "为什么下雨之后会有泥土的味道？"]) {
    const plan = planDialogue(message, []);
    assert.equal(plan.casual, false);
    assert.equal(plan.useLifeContext, "only_if_relevant");
  }
  const history = [
    { role: "assistant", content: "你今天怎么样？" },
    { role: "user", content: "还行" },
    { role: "assistant", content: "晚上有什么打算？" },
  ];
  assert.equal(planDialogue("暂时没想好，可能看电影", history).maxQuestions, 0);
  assert.equal(planDialogue("我今天差点坐过站", [{ role: "user", content: "你怎么啥都要问" }, { role: "assistant", content: "好，不问了" }, { role: "user", content: "我开玩笑的" }]).maxQuestions, 0);
  assert.equal(planDialogue("没钱了只能食堂", [{ role: "assistant", content: "准备吃点什么？" }]).maxQuestions, 0);
  assert.equal(decideReply("我先忙了", history), "warm_close");
  assert.equal(decideReply("我连晚安都没来得及说", history), "conversation");
});

test("review catches reported work monologues without banning relevant work answers", () => {
  const history = [{ role: "assistant", content: "你今天忙不忙？" }];
  assert.ok(reviewDialogue("还好", history, "那就行。我这边还得再画一阵，晚上才收拾这些草稿。").length > 0);
  assert.ok(reviewDialogue("还好", history, "那就先按不好不坏算。").length > 0);
  assert.ok(reviewDialogue("还行吧", history, "嗯，不着急说。想聊别的也行。").length > 0);
  assert.equal(reviewDialogue("你在干嘛", [], "在改稿呢。").length, 0);
  assert.equal(reviewDialogue("还好", history, "那陪我聊会儿呗。").length, 0);
  assert.equal(reviewDialogue("你觉得工作该怎么安排？", [], "工作可以先列出优先级，你现在最急的是哪件？").length, 0);
  assert.ok(reviewDialogue("我刚才差点坐过站", [], "这事我也干过，抬头才反应过来。").length > 0);
});

test("playful social bids are separate from requests for actions or an instant relationship", () => {
  for (const message of ["cpdd", "CPDD", "想谈个恋爱", "处对象吗", "那我排个队？"]) {
    assert.equal(planDialogue(message, []).intent, "playful_bid", message);
    assert.equal(planDialogue(message, []).useLifeContext, "background_only");
  }
  const history = [{ role: "assistant", content: "我可没这业务。" }];
  assert.equal(planDialogue("好吧", history).repairBluntReply, true);
  assert.ok(reviewDialogue("cpdd", [], "你这上来就找对象，我可没这业务。").length);
  assert.equal(reviewDialogue("cpdd", [], "这么直接啊，先聊两句呗。").length, 0);
  for (const boundary of ["别撩我了", "我不想谈恋爱", "不要问为什么", "别逗了，聊点别的"]) assert.equal(planDialogue(boundary, []).intent, "boundary");
});

test("personal questions are answered without interrogating motives, even without a question mark", () => {
  assert.equal(planDialogue("你有对象吗", []).intent, "personal_question");
  assert.equal(planDialogue("你有对象吗", []).maxQuestions, 0);
  for (const output of ["没有。你问这个，是想先确认下我这边有没有情况？", "没有，你问这个是想确认什么。", "嗯，怎么突然想找这个。", "为什么突然问这个", "想谈就谈呗，不过怎么突然说起这个了"]) {
    assert.ok(hasConversationalQuestion(output), output);
    assert.ok(reviewDialogue("你有对象吗", [], output).length, output);
  }
  assert.ok(hasConversationalQuestion("嗯，随便聊聊，今天过得怎么样"));
  assert.equal(reviewDialogue("你有对象吗", [], "没有啊。").length, 0);
  assert.equal(reviewDialogue("你有对象吗", [], "单身，怎么啦？").length > 0, true);
  assert.ok(reviewDialogue("好吧", [], "怎么，听着还有点勉强。").length > 0);
  assert.equal(reviewDialogue("猜猜我为什么突然想谈恋爱", [], "你问这个是不是想让我猜一下").length, 0);
});
