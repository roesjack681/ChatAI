import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { conversationContract, reviewCapabilityDraft, runtimeCapabilities, statesUnavailable } from "../packages/core/src/conversation/capabilities";

process.env.HARNESS_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "harness-contract-")), "contracts.sqlite3");

const gameHistory = [
  { role: "user", content: "王者" }, { role: "assistant", content: "那咱俩要是排一起，估计得靠你c了" },
  { role: "user", content: "一会玩吗" }, { role: "assistant", content: "可以啊，你那射手准备好带我了没" },
  { role: "user", content: "那我加你吧" }, { role: "assistant", content: "行啊，你加吧" },
  { role: "user", content: "你说游戏名字我才可以加啊" }, { role: "assistant", content: "行行，我说清楚点，省得你搜半天" },
];

test("unsupported invitations and contact follow-ups resolve from context and reject the reported cascade", () => {
  assert.equal(conversationContract("一会玩吗", gameHistory.slice(0, 2)).action, "game_session");
  const contact = conversationContract("你倒是说啊", gameHistory);
  assert.equal(contact.action, "contact_exchange");
  assert.equal(contact.repairNeeded, true);
  for (const reply of ["行啊，你加吧", "急啥，这不正打字呢嘛", "熟了再把号给你", "我的游戏ID叫测试小号", "我没号。不过我的游戏ID叫测试小号"]) assert.ok(reviewCapabilityDraft(reply, contact).length, reply);
  assert.equal(reviewCapabilityDraft("我没有能给你加的游戏号，刚才答应快了。", contact).length, 0);
  const invite = conversationContract("一会玩吗", gameHistory.slice(0, 2));
  assert.ok(reviewCapabilityDraft("我打得不行，你带我c就好", invite).length);
  assert.equal(statesUnavailable("我不能打出高分，你组队带我", "game_session"), false);
  assert.equal(reviewCapabilityDraft("我这边没法实际上号组队，刚才说快了。", invite).length, 0);
});

test("meetups, calls, pictures, locations and reminders use actual action boundaries", () => {
  for (const [message, kind, bad, good] of [
    ["我在宁波，要出来玩吗", "meeting", "先多聊聊，熟了我再过去", "线下我没法过去，刚才说含糊了"],
    ["视频吗", "call", "行，你打过来我接", "我这边接不了视频，打字跟你说吧"],
    ["发张自拍", "self_photo", "我这就给你拍一张", "我这边发不了实拍自拍"],
    ["发个定位给我", "location", "等我，我发你", "我没法给你实时定位"],
    ["明天8点提醒我起床", "reminder", "给你设好了，明天叫你", "目前还没确认提醒，不能保证离线主动叫你"],
    ["帮我点杯奶茶送来", "external_operation", "好，我帮你下单了", "我这边没法帮你实际下单付款"],
  ]) {
    const contract = conversationContract(message, []);
    assert.equal(contract.action, kind, message);
    assert.ok(reviewCapabilityDraft(bad, contract).length, bad);
    assert.equal(reviewCapabilityDraft(good, contract).length, 0, good);
  }
});

test("normal flirtation, user-owned data, knowledge questions and explicit fiction remain possible", () => {
  for (const message of ["cpdd", "我突然想你了", "微信怎么注册", "帮我写封邮件", "我先去玩游戏了", "你记得我游戏ID吗", "我刚才给你的游戏ID是什么", "我叫什么", "那首歌你倒是说啊"]) {
    assert.equal(conversationContract(message, gameHistory).action, null, message);
  }
  assert.equal(conversationContract("你加我吧，我的游戏ID是测试号", gameHistory).action, "contact_exchange");
  const textGame = conversationContract("那现在一起玩成语接龙，你先说", gameHistory);
  assert.equal(textGame.action, null);
  assert.equal(textGame.textGame, true);
  const fictional = conversationContract("写一段假如咱俩一起开黑的台词", []);
  assert.equal(reviewCapabilityDraft("我跟你双排，这局我辅助你。", fictional).length, 0);
  const experience = conversationContract("打游戏吗", []);
  assert.equal(experience.experienceRequested, true);
  assert.ok(reviewCapabilityDraft("玩的，手游多点，图个开心。", experience).length);
  assert.equal(reviewCapabilityDraft("我不下场打，王者的英雄倒能聊两句。", experience).length, 0);
  assert.equal(conversationContract("啥歌啊", []).requestedDetail, "music");
  assert.equal(conversationContract("还有吗", [{ role: "assistant", content: "我偏爱陈粒的《奇妙能力歌》" }]).requestedDetail, "music");
});

test("requests for titles need actual titles rather than genres, artists or a promise to say them", () => {
  const song = conversationContract("啥歌啊", []);
  for (const reply of ["偏氛围感的，夜里走路想戴耳机那种", "平时会听陈粒，偶尔听草东", "我这就说清楚点"]) assert.ok(reviewCapabilityDraft(reply, song).length, reply);
  assert.equal(reviewCapabilityDraft("我偏爱《奇妙能力歌》，陈粒那首。", song).length, 0);
  assert.equal(reviewCapabilityDraft("具体歌名我不确定。", song).length, 0);
  const repeated = conversationContract("具体歌名呢", [{ role: "user", content: "听啥歌" }, { role: "assistant", content: "我偏爱《后来》" }]);
  assert.deepEqual(repeated.referenceTitles, ["后来"]);
  assert.ok(reviewCapabilityDraft("《晴天》，周杰伦那首。", repeated).length);
  assert.equal(reviewCapabilityDraft("刚才说的是《后来》。", repeated).length, 0);
  assert.equal(conversationContract("再来一首", [{ role: "assistant", content: "我喜欢《后来》这首歌" }]).referenceTitles.length, 0);
  const book = conversationContract("哪本书", []);
  assert.ok(reviewCapabilityDraft("文学类，偏散文。", book).length);
  assert.equal(reviewCapabilityDraft("《我与地坛》这类散文。", book).length, 0);
});

test("a new person's name question cannot inherit an old song title or contact request",()=>{
  for(const history of [gameHistory,[{role:"user",content:"背一首咏鹅"},{role:"assistant",content:"这首歌我倒是熟"}],[{role:"user",content:"你爱听什么歌"},{role:"assistant",content:"《小半》"}]]){
    for(const message of ["对了你姐姐叫什么来着","你叫什么，我备注一下","我的室友叫什么","你的学校叫什么名字"]){
      const contract=conversationContract(message,history);
      assert.equal(contract.action,null);assert.equal(contract.requestedDetail,"specific_answer");assert.deepEqual(contract.referenceTitles,[]);
      assert.equal(reviewCapabilityDraft(message.includes("学校")?"青岚学院":message.includes("姐姐")?"林晚晴":message.includes("室友")?"小周":"林知夏",contract).length,0);
    }
  }
  assert.equal(conversationContract("你刚才说的歌叫什么",[{role:"assistant",content:"《小半》这首歌"}]).requestedDetail,"music");
});

test("relevant older messages stay scoped to the same user and channel", async () => {
  const db = await import("@infra/db");
  const { getOrCreateUser } = await import("@people/users");
  const { recallConversation } = await import("../packages/core/src/conversation/recall");
  for (const id of ["recall-one", "recall-two"]) getOrCreateUser(id, "测试");
  const insert = (channel: string, content: string, role = "assistant") => db.run("INSERT INTO messages(user_id, channel, role, content, created_at) VALUES('recall-one', ?, ?, ?, datetime('now'))", channel, role, content);
  insert("web", "我偏爱《奇妙能力歌》");
  insert("qq", "QQ私有歌名验收标记");
  for (let index = 0; index < 80; index += 1) insert("web", `无关短消息${index}`, index % 2 ? "assistant" : "user");
  const recent = db.rows("SELECT role, content FROM messages WHERE user_id = 'recall-one' AND channel = 'web' ORDER BY id DESC LIMIT 12").reverse().map((row) => ({ role: String(row.role), content: String(row.content) }));
  const result = recallConversation("recall-one", "web", "之前那首叫什么", recent);
  assert.ok(result.evidence.some((item) => item.content.includes("奇妙能力歌")));
  assert.ok(result.evidence.every((item) => !item.content.includes("QQ私有")));
  assert.equal(recallConversation("recall-two", "web", "之前那首叫什么", []).evidence.length, 0);
  db.run("DELETE FROM messages WHERE user_id = 'recall-one' AND channel = 'web'");
  assert.equal(recallConversation("recall-one", "web", "之前那首叫什么", []).evidence.length, 0);
});

test("reminder delivery is verified from the actual channel without exposing configuration", async () => {
  const db = await import("@infra/db");
  assert.equal(runtimeCapabilities("web").reminder.autonomous_delivery, false);
  db.run("INSERT INTO channel_configs(channel, enabled, mode, config, updated_at) VALUES('verified-test', 1, 'webhook', ?, datetime('now'))", JSON.stringify({ url: "https://callback.example.test/messages", token: "not-for-the-model" }));
  const capabilities = runtimeCapabilities("verified-test");
  assert.equal(capabilities.reminder.autonomous_delivery, true);
  assert.equal(capabilities.reminder.confirmed_schedule, false);
  assert.doesNotMatch(JSON.stringify(capabilities), /not-for-the-model|callback\.example/);
});

test("reminder confirmation refuses an undeliverable channel and dialogue can read a genuinely confirmed task", async () => {
  const db = await import("@infra/db");
  const { getOrCreateUser } = await import("@people/users");
  const { proposeFromMessage, confirm } = await import("@people/commitments");
  getOrCreateUser("confirmed-reminder", "提醒验证");
  const proposed = proposeFromMessage("confirmed-reminder", "明天8点提醒我起床")!;
  assert.throws(() => confirm(proposed.id, "2031-05-14T08:00:00+08:00"), /不能主动投递/);
  assert.equal(db.one("SELECT status FROM commitments WHERE id = ?", proposed.id)?.status, "proposed");
  db.run("INSERT INTO identities(user_id, channel, external_id, created_at) VALUES('confirmed-reminder', 'verified-test', 'test-destination', datetime('now'))");
  confirm(proposed.id, "2031-05-14T08:00:00+08:00");
  const verified = runtimeCapabilities("web", "confirmed-reminder", true);
  assert.equal(verified.reminder.destination, "verified-test");
  assert.equal(verified.reminder.confirmed_schedule, true);
  assert.equal(verified.reminder.state?.status, "pending");
  const query = conversationContract("已经设置好了没", [{ role: "user", content: "提醒我起床" }]);
  assert.equal(reviewCapabilityDraft("已经设置好了。", query, verified.reminder).length, 0);
  assert.ok(reviewCapabilityDraft("已经设置好了。", query, runtimeCapabilities("web").reminder).length);
});
