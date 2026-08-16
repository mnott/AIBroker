/**
 * A handover path that keeps up with the calendar.
 *
 * A managed session is meant to run for days, so a date fixed into its handover
 * path at the moment it was set is wrong by the next morning — and wrong
 * quietly, because the file it names still exists and still opens. These pin
 * the tokens and, just as importantly, that a path without tokens is returned
 * untouched: most paths are literal and must not be rewritten by accident.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveHandoverPath } from "../src/daemon/manage.js";

const AT = new Date(2026, 7, 16, 11, 44); // 16 August 2026, local

test("{date} becomes the local calendar date", () => {
  assert.equal(resolveHandoverPath("Notes/handover-{date}.md", AT), "Notes/handover-2026-08-16.md");
});

test("year, month and day are separately available", () => {
  assert.equal(resolveHandoverPath("Notes/{yyyy}/{mm}/{dd}.md", AT), "Notes/2026/08/16.md");
});

test("months and days are zero-padded, so names sort", () => {
  const january = new Date(2026, 0, 5, 9, 0);
  assert.equal(resolveHandoverPath("h-{date}.md", january), "h-2026-01-05.md");
});

test("a path with no tokens is left exactly as it was", () => {
  const plain = "Notes/Work/handover.md";
  assert.equal(resolveHandoverPath(plain, AT), plain);
});

test("tokens are recognised whatever their case", () => {
  assert.equal(resolveHandoverPath("h-{DATE}.md", AT), "h-2026-08-16.md");
});

test("a token appearing twice is expanded both times", () => {
  assert.equal(resolveHandoverPath("{yyyy}/h-{yyyy}.md", AT), "2026/h-2026.md");
});

test("the date is local, not UTC — an evening date does not slip forward", () => {
  // 23:30 local on the 16th is already the 17th in UTC; the name must not jump.
  const lateEvening = new Date(2026, 7, 16, 23, 30);
  assert.equal(resolveHandoverPath("h-{date}.md", lateEvening), "h-2026-08-16.md");
});
