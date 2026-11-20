import assert from "node:assert/strict";
import { test } from "node:test";
import { characterKnowledge, imageConversationMode, reviewCharacterKnowledge } from "../packages/character/src/knowledge";

const artist = characterKnowledge({ occupation: "独立插画师" });

test("an illustrator does not inherit software operations expertise from vision", () => {
  assert.equal(artist.softwareExpertise, false);
  assert.match(artist.familiar, /配色|构图/);
  for (const output of [
    "看到了，一堆服务在跑。web、redis、mysql 亮着，worker 和 migrate 好像是停着的？你这个是要看哪个出问题了。",
    "Redis 是缓存，worker 是后台任务。",
    "我不太懂。不过你可以先查看容器日志，再重启服务。",
    "执行 docker compose logs worker 看看。",
  ]) assert.ok(reviewCharacterKnowledge(output, artist).length, output);
});

test("reading labels, visual observations, and attributed learning remain possible", () => {
  for (const output of [
    "前面写着 web、redis、mysql、worker、migrate。",
    "我就看出有几个绿点，具体是干什么的我看不懂。",
    "右边那两行写的是 Exited，是什么意思我不知道。",
    "按你说的，Redis 是缓存，我就记住这个了。",
    "红色更抢眼，蓝色放大一点能平衡一下。",
  ]) assert.equal(reviewCharacterKnowledge(output, artist).length, 0, output);
});

test("a role with explicitly configured expertise may use it", () => {
  const engineer = characterKnowledge({ occupation: "后端工程师", knowledge_familiar: "后端开发、数据库管理、容器运维" });
  assert.equal(engineer.softwareExpertise, true);
  assert.equal(reviewCharacterKnowledge("先查看容器日志，再检查服务启动情况。", engineer).length, 0);
});

test("sharing a screenshot does not request an OCR report", () => {
  const report = "web、redis、mysql 是绿点 Running，worker 和 migrate 写着 Exited，我不太懂这些。";
  assert.equal(imageConversationMode("给你看看我在忙什么"), "sharing");
  assert.equal(imageConversationMode("只读出前五行名字，不解释"), "reading");
  assert.ok(reviewCharacterKnowledge(report, artist, { hasImages: true, message: "给你看看我在忙什么" }).length);
  assert.ok(reviewCharacterKnowledge("你是在盯着哪个服务吧，跑起来了没？", artist, { hasImages: true, message: "" }).length);
  assert.equal(reviewCharacterKnowledge("web、redis、mysql、worker、migrate", artist, { hasImages: true, message: "只读出名字" }).length, 0);
  assert.equal(reviewCharacterKnowledge("这是你刚才忙的那个？看起来好复杂。", artist, { hasImages: true, message: "" }).length, 0);
});
