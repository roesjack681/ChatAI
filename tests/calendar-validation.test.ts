import assert from "node:assert/strict";
import { test } from "node:test";
import { matchesCalendarDate } from "../scripts/support/calendar";

test("calendar checks accept explicit dates and unambiguous same-month shorthand", () => {
  for (const reply of ["11月9号", "十一月九日", "2026-11-09", "9号", "按11月6号算的话，下周一就是9号，考得怎么样"]) {
    assert.ok(matchesCalendarDate(reply, "2026-11-09", "2026-11-15"), reply);
  }
});

test("calendar checks reject wrong dates and ambiguous shorthand outside the current month", () => {
  for (const reply of ["12月9号", "十一月八日", "8号", "下周吧"]) assert.equal(matchesCalendarDate(reply, "2026-11-09", "2026-11-15"), false, reply);
  assert.equal(matchesCalendarDate("9号", "2026-11-09", "2026-12-01"), false);
  assert.ok(matchesCalendarDate("按11月6号算，9号考试", "2026-11-09", "2026-12-01"));
});
