import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.HARNESS_DB_PATH = path.join(mkdtempSync(path.join(tmpdir(), "harness-life-context-")), "life.sqlite3");

const oldDefault = { title: "插画工作", details: "按计划处理手头的插画项目", start_time: "09:00", end_time: "18:00", status: "ongoing", source: "template:2" };

async function collegeRole() {
  const character = await import("@character");
  if (character.portrait().occupation !== "大学生") {
    character.publish(character.createDraft("大学生上下文测试", { ...character.active().profile, occupation: "大学生", age: 21 }));
  }
}

test("current activity uses compatible ongoing role events rather than an obsolete workday or private user plan", async () => {
  await collegeRole();
  const { compilePrompt } = await import("@prompting");
  const base = { user: { display_name: "测试" }, memories: [], mood: "平静", events: [
    oldDefault,
    { title: "过去活动验收标记", details: "", start_time: "08:00", status: "completed" },
    { title: "未来活动验收标记", details: "", start_time: "19:00", status: "planned" },
    { title: "用户私有活动验收标记", details: "", start_time: "09:00", status: "ongoing", share_level: "private" },
  ], goals: [{ title: "摄影目标验收标记" }], npcs: [{ name: "熟人验收标记" }] };
  const compiled = compilePrompt({ ...base, userMessage: "在干嘛呢" });
  assert.doesNotMatch(compiled.system, /插画工作|过去活动验收标记|未来活动验收标记|用户私有活动验收标记|摄影目标验收标记|熟人验收标记/);
  assert.match(compiled.system, /这会儿闲着|没忙什么/u);
  assert.equal(compiled.supportingFacts.length, 0);
  for (const userMessage of ["没事干", "你咋这么像ai", "我刚下课，快饿死了"]) {
    assert.doesNotMatch(compilePrompt({ ...base, userMessage }).system, /插画工作|过去活动验收标记|未来活动验收标记|用户私有活动验收标记|摄影目标验收标记|熟人验收标记/);
  }
  const active = compilePrompt({ ...base, userMessage: "在干嘛呢", events: [
    { title: "正在整理笔记验收标记", details: "", start_time: "10:00", status: "ongoing", source: "admin" },
    { ...oldDefault, source: "admin" },
  ] });
  assert.match(active.system, /正在整理笔记验收标记/);
  assert.match(active.system, /插画工作/); // An explicitly authored activity remains valid for a student.
});

test("daily planning retires unchanged obsolete defaults while preserving authored plans and completed history", async () => {
  await collegeRole();
  const world = await import("@world/daily-life");
  const db = await import("@infra/db");
  const day = "2031-05-12";
  const stale = world.addEvent({ title: oldDefault.title, details: oldDefault.details, day, startTime: "09:00", endTime: "18:00", status: "ongoing", source: "template:2" });
  const authored = world.addEvent({ title: "插画练习", details: "自己安排的兴趣活动", day, startTime: "19:30", source: "admin" });
  const completed = world.addEvent({ title: oldDefault.title, details: oldDefault.details, day: "2031-05-11", startTime: "09:00", endTime: "18:00", status: "completed", source: "template:2" });
  const items = world.ensureDailySkeleton(day);
  assert.equal(items.find((event) => event.id === stale)?.status, "cancelled");
  assert.equal(items.find((event) => event.id === authored)?.status, "planned");
  assert.equal(db.one("SELECT status FROM world_events WHERE id = ?", completed)?.status, "completed");
  assert.equal(world.retireIncompatibleDefaultActivities(day), 0);
  for (let date = 13; date <= 19; date += 1) {
    assert.equal(world.ensureDailySkeleton(`2031-05-${date}`).some((event) => event.title === "插画工作" || event.source === "planner:work"), false);
  }
  assert.ok(db.one("SELECT id FROM audit_log WHERE action = 'default_role_activities_retired'"));
});
