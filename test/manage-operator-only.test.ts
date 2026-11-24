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

test("marker absent before until, empty input: re-arm now with the reason", async () => {
  assert.equal(M.reasonToArm(entry(), pane("", false), NOW), "goal gone before until, re-armed");
});

test("not re-armed over typed input, when paused, after until, or with the marker up", async () => {
  assert.notEqual(M.reasonToArm(entry(), pane("half a sentence", false), NOW), M.GOAL_GONE_REASON);
  assert.equal(M.reasonToArm(entry({ paused: true }), pane("", false), NOW), null);
  assert.notEqual(M.reasonToArm(entry(), pane("", false), UNTIL + 1), M.GOAL_GONE_REASON);
  assert.equal(M.reasonToArm(entry(), pane("", true), NOW), null);
});

test("agent off is refused with the message", async () => {
  assert.equal(await M.refuseAgentManage("CaseLeaf", "off", {}, false, NOW), M.AGENT_REFUSAL);
  assert.match(M.AGENT_REFUSAL, /^refused: only the operator ends or shortens a goal \(say "manage <session> off" yourself/);
  assert.equal(await M.refuseAgentManage("CaseLeaf", "pause", {}, false, NOW), M.AGENT_REFUSAL);
  assert.equal(await M.refuseAgentManage("CaseLeaf", "shift off", {}, false, NOW), M.AGENT_REFUSAL);
});

test("agent off with a valid token is accepted and the token is consumed", async () => {
  M.writeOperatorToken("CaseLeaf", "off", NOW);
  const file = join(dir, "operator-tokens", "caseleaf-off.json");
  assert.ok(existsSync(file));
  assert.equal(await M.refuseAgentManage("CaseLeaf", "off", {}, false, NOW + 1000), null);
  assert.ok(!existsSync(file));
  assert.equal(await M.refuseAgentManage("CaseLeaf", "off", {}, false, NOW + 2000), M.AGENT_REFUSAL);
});

test("an expired token is refused", async () => {
  M.writeOperatorToken("CaseLeaf", "off", NOW);
  assert.equal(await M.refuseAgentManage("CaseLeaf", "off", {}, false, NOW + 6 * 60_000), M.AGENT_REFUSAL);
});

test("a token for another action does not open off", async () => {
  M.writeOperatorToken("CaseLeaf", "pause", NOW);
  assert.equal(await M.refuseAgentManage("CaseLeaf", "off", {}, false, NOW + 1000), M.AGENT_REFUSAL);
});

test("operator calls pass", async () => {
  assert.equal(await M.refuseAgentManage("CaseLeaf", "off", {}, true, NOW), null);
});

test("supervise: earlier until refused, later accepted; status and now untouched", async () => {
  assert.equal(await M.refuseAgentManage("CaseLeaf", "supervise", { until: "1h" }, false, NOW), M.AGENT_REFUSAL);
  assert.equal(await M.refuseAgentManage("CaseLeaf", "supervise", { until: "8h" }, false, NOW), null);
  assert.equal(await M.refuseAgentManage("CaseLeaf", "supervise", {}, false, NOW), null);
  assert.equal(await M.refuseAgentManage("CaseLeaf", "shift 1h", {}, false, NOW), M.AGENT_REFUSAL);
  assert.equal(await M.refuseAgentManage("CaseLeaf", "shift 8h", {}, false, NOW), null);
  assert.equal(await M.refuseAgentManage("CaseLeaf", "status", {}, false, NOW), null);
  assert.equal(await M.refuseAgentManage("CaseLeaf", "now", {}, false, NOW), null);
  assert.equal(await M.refuseAgentManage("CaseLeaf", "set new wording", { until: "1h" }, false, NOW), M.AGENT_REFUSAL);
  assert.equal(await M.refuseAgentManage("CaseLeaf", "set new wording", {}, false, NOW), null);
});

test("shift with a clock until: same minute allowed, earlier refused, later allowed", async () => {
  // stored until is 00:30 the next day; the sentence is the live repro's shape
  const text = "shift until 00:30 with your controls, same workers as tonight";
  assert.equal(await M.refuseAgentManage("CaseLeaf", text, {}, false, NOW), null);
  assert.equal(await M.refuseAgentManage("CaseLeaf", text, {}, false, NOW + 7), null);
  assert.equal(await M.refuseAgentManage("CaseLeaf", "shift until 00:00", {}, false, NOW), M.AGENT_REFUSAL);
  assert.equal(await M.refuseAgentManage("CaseLeaf", "shift until 02:00 with your controls", {}, false, NOW), null);
  assert.equal(await M.refuseAgentManage("CaseLeaf", "supervise", { until: "00:30" }, false, NOW + 7), null);
});

test("the CLI under an agent environment is not the operator", async () => {
  assert.equal(runsUnderAgent({ CLAUDECODE: "1" }), true);
  assert.equal(runsUnderAgent({ CLAUDE_CODE_SESSION_ID: "abc" }), true);
  assert.equal(runsUnderAgent({ PAI_WORKER: "1" }), true);
  assert.equal(runsUnderAgent({}), false);
});

const HOOK = join(process.cwd(), "hooks", "operator-manage-token.mjs");
const runHook = (prompt: string) =>
  spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ prompt }), env: { ...process.env, HOME: homedir() }, encoding: "utf8" });
const tokenFile = join(dir, "operator-tokens", "caseleaf-off.json");

test("hook writes a token for a bare prompt, none for a [Session:X] prompt", async () => {
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
  assert.equal(await M.refuseAgentManage("CaseLeaf", "off", {}, false), null);
});

test("armed text starts with the no-done-state prefix, within the line limit", async () => {
  const withUntil = M.buildGoalLine("~/.aibroker/manage-briefs/caseleaf.md", "Until the Pencil fix is in build 142 ".repeat(20), UNTIL);
  assert.ok(withUntil.startsWith("/goal Keep working until 2026-10-13 00:30, then the goal is met: allow the stop. Before that there is no done-state; only the operator ends this goal. Allow the stop after an operator interrupt. Follow "), withUntil);
  assert.ok(withUntil.length <= 250);
  const open = M.buildGoalLine("~/.aibroker/manage-briefs/caseleaf.md", "work", null);
  assert.ok(open.startsWith("/goal Keep working. There is no done-state. Only the operator ends this goal."));
});

test("a fresh demand is not held by a stale queuedArmAt: busy session gets the forced arm", async () => {
  const m = entry({ queuedArmAt: NOW - 120_000 });
  M.applySupervise(m, "new goal", null, null);
  assert.equal(m.lastRearmAt, 0);
  assert.equal(m.queuedArmAt, undefined);
  assert.equal(M.busyGoalGoneReason(m, pane("", true), NOW, true), M.GOAL_FORCED_BUSY_REASON);
});

test("dormant watcher is shelved on a lost pane and restored by name after a restart", () => {
  const dormant: Record<string, import("../src/daemon/manage.js").ManagedSession> = {};
  const m = entry({ every: undefined, handoverDoneAt: NOW - 1000 });
  assert.equal(M.shelveDormant(dormant, m, NOW), true);
  assert.equal(M.shelveDormant({}, entry({ objective: "" }), NOW), false);
  assert.equal(M.shelveDormant({}, entry(), UNTIL + 1), false, "an ended goal is not kept");
  const active: Record<string, import("../src/daemon/manage.js").ManagedSession> = {};
  const NEW = "11111111-0000-0000-0000-000000000000";
  assert.deepEqual(M.restoreDormant(active, dormant, [{ id: "other", paiName: "Elsewhere" }], NOW), []);
  assert.deepEqual(M.restoreDormant(active, dormant, [{ id: NEW, paiName: "caseleaf" }], NOW), ["CaseLeaf"]);
  assert.equal(active[NEW].sessionId, NEW);
  assert.equal(active[NEW].objective, "x");
  assert.equal(active[NEW].shift?.until, UNTIL, "goal and until untouched");
  assert.equal(active[NEW].handoverDoneAt, NOW - 1000, "last handover kept");
  assert.equal(Object.keys(dormant).length, 0);
});

test("a goal with no watcher gets one when the session is seen; an expired goal does not", () => {
  const dormant = { old: entry({ sessionId: "old" }) };
  const active: Record<string, import("../src/daemon/manage.js").ManagedSession> = {};
  assert.deepEqual(M.restoreDormant(active, dormant, [{ id: "n1", paiName: "CaseLeaf" }], UNTIL + 1), []);
  assert.equal(Object.keys(active).length, 0);
  assert.equal(Object.keys(dormant).length, 0, "expired record discarded");
});

test("handover command types the handover instruction into the right session", async () => {
  const typed: [string, string][] = [];
  const r = await M.handoverNow("CaseLeaf", { type: (id, t) => typed.push([id, t]), cwdOf: async () => null });
  assert.equal(r.ok, true);
  assert.equal(typed.length, 1);
  assert.equal(typed[0][0], SID);
  assert.match(typed[0][1], /^Write your handover now, for your post-compact self/);
  assert.match(typed[0][1], /TODO\.md Continue section, the session note, open workers and specs, decisions made and lessons/);
  const none = await M.handoverNow("NoSuchSession", { type: () => assert.fail("must not type"), cwdOf: async () => null });
  assert.equal(none.ok, false);
});

test("after until the shift-over path clears the goal once, only at an empty prompt, and does not re-arm", async () => {
  const typed: string[] = [];
  const mk = (atPrompt: boolean, input: string) => ({
    live: async () => ({ atPrompt, name: "(claude)" }),
    readPane: async () => pane(input, true),
    paste: async (t: string) => { typed.push(t); return true; },
    enter: async () => { typed.push("<CR>"); },
  });
  assert.equal(await M.clearGoal(SID, mk(true, "half typed")), "deferred", "never over unsent text");
  assert.equal(await M.clearGoal(SID, mk(false, "")), "deferred", "not while the turn runs");
  assert.deepEqual(typed, []);
  assert.equal(await M.clearGoal(SID, mk(true, "")), "cleared");
  assert.deepEqual(typed, ["/goal clear", "<CR>"]);
  const m = entry({ shift: { until: UNTIL, workers: 1, visual: false, startedAt: NOW, plain: true } });
  assert.equal(M.shiftOver(m, UNTIL + 1), true);
  assert.equal(M.reasonToArm(m, pane("", false), UNTIL + 1), null, "no re-arm after until");
});

test("before until the goal text still blocks the stop", () => {
  const t = M.noDoneStatePrefix(UNTIL);
  assert.ok(t.includes("only the operator ends this goal") && t.includes("no done-state") && t.includes("2026-10-13 00:30"));
});

test("hook install is idempotent: a duplicate install or a pre-existing duplicate leaves one hook", async () => {
  const S = await import("../src/daemon/setup.js");
  const sys = { home: "/h", pkgRoot: "/pkg", execPath: "node" } as any;
  const once = S.mergeHooks({}, sys).settings;
  const twice = S.mergeHooks(once, sys).settings;
  assert.deepEqual(twice, once);
  const dup = structuredClone(once);
  dup.hooks.Stop.push(structuredClone(dup.hooks.Stop[0]));
  const fixed = S.mergeHooks(dup, sys).settings;
  assert.equal(fixed.hooks.Stop.flatMap((g: any) => g.hooks).filter((h: any) => h.command.includes("aibroker-route-guard")).length, 1);
});
