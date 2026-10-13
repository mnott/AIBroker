import "./home-guard.js";
/** test/manage-until-passed.test.ts — nothing proactive after `until`, nor while paused. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

mkdirSync(join(homedir(), ".aibroker"), { recursive: true });
writeFileSync(join(homedir(), ".aibroker", "managers.json"), "{}");
const M = await import("../src/daemon/manage.js");

const NOW = new Date(2026, 9, 13, 8, 10, 0).getTime();
const RULE = "─".repeat(40);
const pane = (marker: boolean) => `${marker ? "◎ /goal active (3m)\n" : ""}● done\n${RULE}\n❯ \n${RULE}\n`;
const entry = (over = {}) => ({
  sessionId: "s", name: "Alpha", objective: "x", pending: [], history: [], nudgeEveryMin: 5,
  lastRearmAt: NOW - 600_000, lastChangeAt: NOW - 3_600_000, lastNudgeAt: 0, lastHash: "", paused: false, startedAt: NOW - 36_000_000,
  shift: { until: NOW - 600_000, workers: 1, visual: false, startedAt: NOW - 36_000_000, plain: true }, ...over,
}) as import("../src/daemon/manage.js").ManagedSession;
const future = { until: NOW + 3_600_000, workers: 1, visual: false, startedAt: NOW - 3_600_000, plain: true };

test("until passed: no goal-gone / lapse re-arm and no idle nudge", () => {
  assert.equal(M.shiftOver(entry(), NOW), true);
  assert.equal(M.reasonToArm(entry(), pane(false), NOW), null);
  assert.equal(M.busyGoalGoneReason(entry(), pane(false), NOW, true), null);
  assert.equal(M.nudgeDue(entry(), pane(true), NOW), false);
});

test("until future: goal-gone re-arm and nudge as before", () => {
  assert.equal(M.shiftOver(entry({ shift: future }), NOW), false);
  assert.equal(M.reasonToArm(entry({ shift: future }), pane(false), NOW), M.GOAL_GONE_REASON);
  assert.equal(M.nudgeDue(entry({ shift: future }), pane(true), NOW), true);
});

test("paused: no re-arm, no nudge", () => {
  assert.equal(M.reasonToArm(entry({ shift: future, paused: true }), pane(false), NOW), null);
  assert.equal(M.nudgeDue(entry({ shift: future, paused: true }), pane(true), NOW), false);
});

test("unshifted session keeps its lapse behaviour", () => {
  assert.equal(M.shiftOver(entry({ shift: undefined }), NOW), false);
  assert.match(M.reasonToArm(entry({ shift: undefined }), pane(false), NOW)!, /^no goal armed/);
});
