import "./home-guard.js";
/** test/manage-busy-goal-gone.test.ts — goal gone mid-turn queues one arm behind the turn. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

mkdirSync(join(homedir(), ".aibroker"), { recursive: true });
writeFileSync(join(homedir(), ".aibroker", "managers.json"), "{}");
const M = await import("../src/daemon/manage.js");

const NOW = new Date(2026, 9, 12, 20, 30, 0).getTime();
const RULE = "─".repeat(40);
const pane = (input: string, marker: boolean) =>
  `${marker ? "◎ /goal active (3m)\n" : ""}● done\n${RULE}\n❯ ${input}\n${RULE}\n`;
const entry = (over = {}) => ({
  sessionId: "s", name: "CaseLeaf", objective: "x", pending: [], history: [],
  lastRearmAt: NOW - 600_000, lastChangeAt: NOW - 60_000, lastHash: "", paused: false, startedAt: NOW - 3_600_000,
  shift: { until: NOW + 3_600_000, workers: 1, visual: false, startedAt: NOW - 3_600_000, plain: true }, ...over,
}) as import("../src/daemon/manage.js").ManagedSession;

test("busy, marker absent, empty line, until ahead: arm now", () => {
  assert.equal(M.busyGoalGoneReason(entry(), pane("", false), NOW, true), "goal gone before until, re-armed (session busy, queued)");
});

test("busy, marker absent, text in the input: no", () => {
  assert.equal(M.busyGoalGoneReason(entry(), pane("half a sentence", false), NOW, true), null);
});

test("busy, marker present: no; and a stale pending mark is cleared", () => {
  const m = entry({ queuedArmAt: NOW - 1000 });
  assert.equal(M.busyGoalGoneReason(m, pane("", true), NOW, true), null);
  assert.equal(m.queuedArmAt, undefined);
});

test("not busy is the idle rule's business, not this one", () => {
  assert.equal(M.busyGoalGoneReason(entry(), pane("", false), NOW, false), null);
});

test("a pending queued arm blocks a second one until the wait lapses", () => {
  const m = entry({ queuedArmAt: NOW - 60_000 });
  assert.equal(M.busyGoalGoneReason(m, pane("", false), NOW, true), null);
  assert.ok(M.busyGoalGoneReason(m, pane("", false), NOW + M.QUEUED_ARM_WAIT_MS, true));
});

test("paused or after until: no", () => {
  assert.equal(M.busyGoalGoneReason(entry({ paused: true }), pane("", false), NOW, true), null);
  assert.equal(M.busyGoalGoneReason(entry(), pane("", false), NOW + 5 * 3_600_000, true), null);
});
