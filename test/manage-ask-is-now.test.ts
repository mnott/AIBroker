import "./home-guard.js";
/**
 * test/manage-ask-is-now.test.ts — every ask for arming is NOW.
 *
 * Operator rule, 2026-10-17 14:48: "it should not be necessary to say now.
 * every ask for arming is now." The grace period the manager's creation once
 * set (`lastRearmAt: Date.now()`, the benefit of the doubt instead of arming
 * on top of whatever was running) predates safe mid-turn queuing — a queued
 * arm lands at the turn boundary and interrupts nothing — so its reason is
 * gone.
 *
 * Pins: a manager created seconds ago arms on the very next tick; changing or
 * extending the objective on an existing manager demands the arm; an
 * instruction queued for delivery demands the arm that carries it; `now`
 * stays as the explicit re-arm verb.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

mkdirSync(join(homedir(), ".aibroker"), { recursive: true });
writeFileSync(join(homedir(), ".aibroker", "managers.json"), "{}");

const SID = "99999999-8888-7777-6666-555555555555";
const realDiscovery = await import("../src/core/session-discovery.js");
const realContent = await import("../src/daemon/session-content.js");
mock.module("../src/core/session-discovery.js", {
  namedExports: { ...realDiscovery, discoverLiveSessions: () => [{ id: SID, aibrokerId: SID, name: "Ask Now", paiName: "Ask Now" }] },
});
mock.module("../src/daemon/session-content.js", {
  namedExports: { ...realContent, readSessionContent: () => ({ content: "", name: "Ask Now (claude)", atPrompt: false }) },
});
mock.module("../src/daemon/peer-handlers.js", { namedExports: { forwardToPeer: async () => null } });

const M = await import("../src/daemon/manage.js");
import type { ManagedSession } from "../src/daemon/manage.js";

const NOW = new Date(2026, 9, 17, 15, 0, 0).getTime();
const RULE = "─".repeat(40);
const pane = (input: string, marker = true) =>
  `${marker ? "◎ /goal active (3m)\n" : ""}● done\n${RULE}\n❯ ${input}\n${RULE}\n`;

const entry = (over: Partial<ManagedSession> = {}): ManagedSession => ({
  sessionId: "s", name: "AskNowLeaf", objective: "work", pending: [], history: [],
  lastRearmAt: NOW - 600_000, lastChangeAt: NOW - 60_000, lastHash: "", paused: false,
  startedAt: NOW - 3_600_000, ...over,
});

// ── the wiring: what the operator's commands actually record ─────────────────

test("a manager created seconds ago is arming on the very next tick", async () => {
  const started = await M.handleManage(SID, "start keep the inbound queue drained");
  assert.ok(started.ok, started.message);
  const status = await M.handleManage(SID, "status");
  assert.match(status.message, /arming on the next tick/, status.message);
});

test("replacing the objective on an existing manager re-arms immediately", async () => {
  const r = await M.handleManage(SID, "start watch the outbound queue instead");
  assert.match(r.message, /objective replaced/);
  const status = await M.handleManage(SID, "status");
  assert.match(status.message, /arming on the next tick/, status.message);
});

test("extending the objective re-arms too", async () => {
  const r = await M.handleManage(SID, "add skip the flaky one");
  assert.match(r.message, /objective extended/);
  const status = await M.handleManage(SID, "status");
  assert.match(status.message, /arming on the next tick/, status.message);
});

test("an instruction demands the arming that delivers it", async () => {
  const r = await M.handleManage(SID, "instruct run the flaky suite first");
  assert.match(r.message, /noted for/);
  const status = await M.handleManage(SID, "status");
  assert.match(status.message, /arming on the next tick/, status.message);
  assert.match(status.message, /1 instruction\(s\) waiting/);
});

test("`now` remains the explicit re-arm verb", async () => {
  const r = await M.handleManage(SID, "now");
  assert.match(r.message, /armed on the next tick/);
  const status = await M.handleManage(SID, "status");
  assert.match(status.message, /arming on the next tick/, status.message);
  await M.handleManage(SID, "off");
});

// ── the policy the wiring is made of ─────────────────────────────────────────

test("setObjective turns an old arm into a demand, and the demand arms despite a fresh marker", () => {
  const m = entry({ lastRearmAt: NOW - 600_000 });
  M.setObjective(m, "the corrected objective");
  assert.equal(m.objective, "the corrected objective");
  assert.equal(m.lastRearmAt, 0);
  assert.equal(M.reasonToArm(m, pane(""), NOW + 1_000), M.FORCED_ARM_REASON);
  // Mid-turn it queues behind the turn instead of waiting for an idle tick.
  assert.equal(M.busyGoalGoneReason(m, pane("", true), NOW + 1_000, true), M.GOAL_FORCED_BUSY_REASON);
});

test("queueInstruction queues AND demands the arm that goes out with it", () => {
  const m = entry({ lastRearmAt: NOW - 600_000 });
  M.queueInstruction(m, "run the flaky suite first");
  assert.deepEqual(m.pending, ["run the flaky suite first"]);
  assert.equal(m.lastRearmAt, 0);
  assert.equal(M.reasonToArm(m, pane("", false), NOW + 1_000), M.FORCED_ARM_REASON);
});

test("supervise with a goal still demands the arm (unchanged)", () => {
  const m = entry({ lastRearmAt: NOW - 600_000 });
  M.applySupervise(m, "a fresh goal", null, null);
  assert.equal(m.lastRearmAt, 0);
});
