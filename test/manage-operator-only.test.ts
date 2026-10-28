import "./home-guard.js";
/**
 * test/manage-operator-only.test.ts — only the operator ends or shortens a goal.
 * Goal gone before `until` re-arms at once; agent calls that end/shorten are
 * refused unless a one-shot operator token exists; the armed text can never
 * name a done-state.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const SID = "99999999-2222-3333-4444-555555555555";
const NOW = new Date(2026, 9, 12, 20, 30, 0).getTime();
const UNTIL = NOW + 4 * 3_600_000;
const dir = join(homedir(), ".aibroker");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "managers.json"), JSON.stringify({
  [SID]: {
    sessionId: SID, name: "CaseLeaf", objective: "work the list", pending: [], history: [],
    lastRearmAt: NOW - 3_600_000, lastChangeAt: NOW - 3_600_000, lastHash: "", paused: false,
    startedAt: NOW - 7_200_000, shift: { until: UNTIL, workers: 1, visual: false, startedAt: NOW - 3_600_000, plain: true },
  },
}));

const realDiscovery = await import("../src/core/session-discovery.js");
mock.module("../src/core/session-discovery.js", {
  namedExports: { ...realDiscovery, discoverLiveSessions: () => [{ id: SID, aibrokerId: SID, name: "CaseLeaf", paiName: "CaseLeaf" }] },
});
const M = await import("../src/daemon/manage.js");
const { runsUnderAgent } = await import("../src/daemon/agent-env.js");

const RULE = "─".repeat(40);
const pane = (input: string, marker: boolean) =>
  `${marker ? "◎ /goal active (3m)\n" : ""}● done\n${RULE}\n❯ ${input}\n${RULE}\n`;
const entry = (over = {}) => ({
  sessionId: SID, name: "CaseLeaf", objective: "x", pending: [], history: [],
  lastRearmAt: NOW - 600_000, lastChangeAt: NOW - 60_000, lastHash: "", paused: false, startedAt: NOW - 3_600_000,
  shift: { until: UNTIL, workers: 1, visual: false, startedAt: NOW - 3_600_000, plain: true }, ...over,
}) as import("../src/daemon/manage.js").ManagedSession;

test("marker absent before until, empty input: re-arm now with the reason", () => {
  assert.equal(M.reasonToArm(entry(), pane("", false), NOW), "goal gone before until, re-armed");
});

test("not re-armed over typed input, when paused, after until, or with the marker up", () => {
  assert.notEqual(M.reasonToArm(entry(), pane("half a sentence", false), NOW), M.GOAL_GONE_REASON);
  assert.equal(M.reasonToArm(entry({ paused: true }), pane("", false), NOW), null);
  assert.notEqual(M.reasonToArm(entry(), pane("", false), UNTIL + 1), M.GOAL_GONE_REASON);
  assert.equal(M.reasonToArm(entry(), pane("", true), NOW), null);
});

test("agent off is refused with the message", () => {
  assert.equal(M.refuseAgentManage("CaseLeaf", "off", {}, false, NOW), M.AGENT_REFUSAL);
  assert.match(M.AGENT_REFUSAL, /^refused: only the operator ends or shortens a goal \(say "manage <session> off" yourself/);
  assert.equal(M.refuseAgentManage("CaseLeaf", "pause", {}, false, NOW), M.AGENT_REFUSAL);
  assert.equal(M.refuseAgentManage("CaseLeaf", "shift off", {}, false, NOW), M.AGENT_REFUSAL);
});

test("agent off with a valid token is accepted and the token is consumed", () => {
  M.writeOperatorToken("CaseLeaf", "off", NOW);
  const file = join(dir, "operator-tokens", "caseleaf-off.json");
  assert.ok(existsSync(file));
  assert.equal(M.refuseAgentManage("CaseLeaf", "off", {}, false, NOW + 1000), null);
  assert.ok(!existsSync(file));
  assert.equal(M.refuseAgentManage("CaseLeaf", "off", {}, false, NOW + 2000), M.AGENT_REFUSAL);
});

test("an expired token is refused", () => {
  M.writeOperatorToken("CaseLeaf", "off", NOW);
  assert.equal(M.refuseAgentManage("CaseLeaf", "off", {}, false, NOW + 6 * 60_000), M.AGENT_REFUSAL);
});

test("a token for another action does not open off", () => {
  M.writeOperatorToken("CaseLeaf", "pause", NOW);
  assert.equal(M.refuseAgentManage("CaseLeaf", "off", {}, false, NOW + 1000), M.AGENT_REFUSAL);
});

test("operator calls pass", () => {
  assert.equal(M.refuseAgentManage("CaseLeaf", "off", {}, true, NOW), null);
});

test("supervise: earlier until refused, later accepted; status and now untouched", () => {
  assert.equal(M.refuseAgentManage("CaseLeaf", "supervise", { until: "1h" }, false, NOW), M.AGENT_REFUSAL);
  assert.equal(M.refuseAgentManage("CaseLeaf", "supervise", { until: "8h" }, false, NOW), null);
  assert.equal(M.refuseAgentManage("CaseLeaf", "supervise", {}, false, NOW), null);
  assert.equal(M.refuseAgentManage("CaseLeaf", "shift 1h", {}, false, NOW), M.AGENT_REFUSAL);
  assert.equal(M.refuseAgentManage("CaseLeaf", "shift 8h", {}, false, NOW), null);
  assert.equal(M.refuseAgentManage("CaseLeaf", "status", {}, false, NOW), null);
  assert.equal(M.refuseAgentManage("CaseLeaf", "now", {}, false, NOW), null);
  assert.equal(M.refuseAgentManage("CaseLeaf", "set new wording", { until: "1h" }, false, NOW), M.AGENT_REFUSAL);
  assert.equal(M.refuseAgentManage("CaseLeaf", "set new wording", {}, false, NOW), null);
});

test("shift with a clock until: same minute allowed, earlier refused, later allowed", () => {
  // stored until is 00:30 the next day; the sentence is the live repro's shape
  const text = "shift until 00:30 with your controls, same workers as tonight";
  assert.equal(M.refuseAgentManage("CaseLeaf", text, {}, false, NOW), null);
  assert.equal(M.refuseAgentManage("CaseLeaf", text, {}, false, NOW + 7), null);
  assert.equal(M.refuseAgentManage("CaseLeaf", "shift until 00:00", {}, false, NOW), M.AGENT_REFUSAL);
  assert.equal(M.refuseAgentManage("CaseLeaf", "shift until 02:00 with your controls", {}, false, NOW), null);
  assert.equal(M.refuseAgentManage("CaseLeaf", "supervise", { until: "00:30" }, false, NOW + 7), null);
});

test("the CLI under an agent environment is not the operator", () => {
  assert.equal(runsUnderAgent({ CLAUDECODE: "1" }), true);
  assert.equal(runsUnderAgent({ CLAUDE_CODE_SESSION_ID: "abc" }), true);
  assert.equal(runsUnderAgent({ PAI_WORKER: "1" }), true);
  assert.equal(runsUnderAgent({}), false);
});

const HOOK = join(process.cwd(), "hooks", "operator-manage-token.mjs");
const runHook = (prompt: string) =>
  spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ prompt }), env: { ...process.env, HOME: homedir() }, encoding: "utf8" });
const tokenFile = join(dir, "operator-tokens", "caseleaf-off.json");

test("hook writes a token for a bare prompt, none for a [Session:X] prompt", () => {
  try { unlinkSync(tokenFile); } catch { /* none yet */ }
  runHook("[Session:Other] please run manage CaseLeaf off");
  assert.ok(!existsSync(tokenFile));
  runHook("[PAILot] manage CaseLeaf off");
  assert.ok(!existsSync(tokenFile));
  runHook("manage CaseLeaf off");
  assert.ok(existsSync(tokenFile));
  const { expiresAt } = JSON.parse(readFileSync(tokenFile, "utf8"));
  assert.ok(expiresAt > Date.now() && expiresAt <= Date.now() + 5 * 60_000);
  // and the daemon side accepts exactly what the hook wrote
  assert.equal(M.refuseAgentManage("CaseLeaf", "off", {}, false), null);
});

test("armed text starts with the no-done-state prefix, within the line limit", () => {
  const withUntil = M.buildGoalLine("~/.aibroker/manage-briefs/caseleaf.md", "Until the Pencil fix is in build 142 ".repeat(20), UNTIL);
  assert.ok(withUntil.startsWith("/goal Keep working until 00:30. There is no earlier done-state. Only the operator ends this goal. Follow "), withUntil);
  assert.ok(withUntil.length <= 250);
  const open = M.buildGoalLine("~/.aibroker/manage-briefs/caseleaf.md", "work", null);
  assert.ok(open.startsWith("/goal Keep working. There is no done-state. Only the operator ends this goal."));
});

test("a fresh demand is not held by a stale queuedArmAt: busy session gets the forced arm", () => {
  const m = entry({ queuedArmAt: NOW - 120_000 });
  M.applySupervise(m, "new goal", null, null);
  assert.equal(m.lastRearmAt, 0);
  assert.equal(m.queuedArmAt, undefined);
  assert.equal(M.busyGoalGoneReason(m, pane("", true), NOW, true), M.GOAL_FORCED_BUSY_REASON);
});
