import "./home-guard.js";
/**
 * test/manage-brief.test.ts — the typed /goal stays short and points at a
 * brief file; arming is only "armed" when the goal marker shows and the input
 * line is empty; shift keeps the operator's objective; start replaces it.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

mkdirSync(join(homedir(), ".aibroker"), { recursive: true });

const SID = "11111111-2222-3333-4444-555555555555";
const realDiscovery = await import("../src/core/session-discovery.js");
const realContent = await import("../src/daemon/session-content.js");
mock.module("../src/core/session-discovery.js", {
  namedExports: { ...realDiscovery, discoverLiveSessions: () => [{ id: SID, aibrokerId: SID, name: "Brief Test", paiName: "Brief Test" }] },
});
mock.module("../src/daemon/session-content.js", {
  namedExports: { ...realContent, readSessionContent: () => ({ content: "", name: "Brief Test (claude)", atPrompt: false }) },
});
mock.module("../src/daemon/peer-handlers.js", { namedExports: { forwardToPeer: async () => null } });
const { buildGoalLine, buildBrief, confirmArmed, briefSlug, handleManage, shiftObjective } = await import("../src/daemon/manage.js");

const LEGEND = "T R S Q A X. keys i id g goal o own n forbid d steps p proof u out l limits r res c changes t tests G gate I inst m images # nums w worst x next z note(<200ch) r=+ only if all t +.";
const BRIEF_PATH = "~/.aibroker/manage-briefs/some-session.md";

test("line never exceeds 250 chars, whatever the objective; brief holds all of it", () => {
  const objective = "audit the queue handler ".repeat(85);
  assert.ok(objective.length > 2000);
  const rules = "read ~/.aibroker/manage-rules.txt";
  const shiftRules = "Work the open issues one at a time";
  const notes = ["do the tests before the docs", "skip the flaky one"];
  const line = buildGoalLine(BRIEF_PATH, objective);
  assert.ok(line.length <= 250, `${line.length}`);
  assert.ok(line.startsWith(`/goal Follow ${BRIEF_PATH} until done`));
  assert.ok(!line.includes("\n"));
  const brief = buildBrief({ objective, agentish: LEGEND, rulesSource: rules, shiftRules, hands: "THE OPERATOR HAS THE SCREEN", pending: notes });
  for (const piece of [objective, LEGEND, rules, shiftRules, "THE OPERATOR HAS THE SCREEN", ...notes]) {
    assert.ok(brief.includes(piece), piece.slice(0, 30));
  }
});

test("a short objective rides on the line after the pointer", () => {
  assert.equal(buildGoalLine(BRIEF_PATH, "fix the toolbar"), `/goal Follow ${BRIEF_PATH} until done: fix the toolbar`);
});

test("slug is file-name safe", () => {
  assert.equal(briefSlug({ name: "Paper full/1", sessionId: "x" }), "paper-full-1");
  assert.equal(briefSlug({ name: "", sessionId: "AB:12" }), "AB12");
});

const deps = (panes: string[], cleared: { n: number }) => {
  let i = 0;
  return {
    readPane: () => panes[Math.min(i++, panes.length - 1)],
    sleep: async () => {},
    clearInput: () => { cleared.n++; },
  };
};
const RULE = "──────────────────────────";
const pane = (input: string, marker: boolean) => `${marker ? "◎ /goal active" : ""}\n${RULE}\n❯ ${input}\n${RULE}\n`;

test("armed when the marker shows and the input line is empty", async () => {
  const cleared = { n: 0 };
  assert.equal(await confirmArmed("/goal Follow x until done", deps([pane("", false), pane("", true)], cleared)), true);
  assert.equal(cleared.n, 0);
});

test("failed arm: our line still in the input is cleared and reported as not armed", async () => {
  const cleared = { n: 0 };
  const typed = "/goal Follow x until done";
  assert.equal(await confirmArmed(typed, deps([pane(typed, false)], cleared)), false);
  assert.equal(cleared.n, 1);
});

test("failed arm never clears text that is not ours", async () => {
  const cleared = { n: 0 };
  assert.equal(await confirmArmed("/goal Follow x until done", deps([pane("half a sentence by the operator", false)], cleared)), false);
  assert.equal(cleared.n, 0);
});

// ── handleManage: shift keeps the objective, start replaces it ───────────────

test("start creates, then start again replaces the objective instead of becoming a note", async () => {
  const first = await handleManage(SID, "start audit the queue handler");
  assert.ok(first.ok, first.message);
  const second = await handleManage(SID, "start review the router");
  assert.match(second.message, /objective replaced/);
  const status = await handleManage(SID, "status");
  assert.match(status.message, /objective: review the router/);
  assert.doesNotMatch(status.message, /instruction\(s\) waiting/);
});

test("instruct stays a one-shot note; the objective is untouched", async () => {
  const r = await handleManage(SID, "instruct tests before docs");
  assert.match(r.message, /noted for/);
  const status = await handleManage(SID, "status");
  assert.match(status.message, /objective: review the router/);
  assert.match(status.message, /1 instruction\(s\) waiting/);
});

test("shift keeps the operator's objective and does not drop notes", async () => {
  const r = await handleManage(SID, "shift for 2 hours");
  assert.ok(r.ok, r.message);
  assert.match(r.message, /Objective kept/);
  const status = await handleManage(SID, "status");
  assert.match(status.message, /objective: review the router/);
  assert.notEqual(shiftObjective(), "review the router");
  await handleManage(SID, "off");
});
