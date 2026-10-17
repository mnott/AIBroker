import "./home-guard.js";
/**
 * test/manage-arm-skip.test.ts — a guard skip is not an arm failure, and a
 * demanded arm is never silenced.
 *
 * Observed live 2026-10-17 14:42: the operator demanded an arm ("arm NOW") and
 * was, at that moment, typing into the pane. The occupied input line made
 * every attempt a "failure", three of them crossed the ARM_ATTEMPTS cap, the
 * cap consumed the forced-arm sentinel (lastRearmAt === 0), and the stuck
 * gate muted every tick after that — the demanded goal was never even typed.
 *
 * These tests pin the three repairs: arm() answers "skipped" when the
 * input-line guard declines and that outcome counts toward nothing; the cap
 * never stamps a pending forced-arm sentinel; the stuck backoff never holds a
 * demanded arm.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

// The brief the goal line points at is written into the (sandboxed) home.
mkdirSync(join(homedir(), ".aibroker", "manage-briefs"), { recursive: true, mode: 0o700 });

// Every pane read and every keystroke below is a stub; nothing here touches a
// real terminal. The stub keeps ONE model of the pane — what sits unsent on
// the input line, and whether the goal marker is up — and the typing
// primitives move it the way a real pane moves.
let inputLine = "";
let markerUp = false;
let pasteOk = true;
let pastes = 0;
let enters = 0;
const reset = () => {
  inputLine = "";
  markerUp = false;
  pasteOk = true;
  pastes = 0;
  enters = 0;
};

const realFacade = await import("../src/transport/sync-facade.js");
const realContent = await import("../src/daemon/session-content.js");

mock.module("../src/transport/sync-facade.js", {
  namedExports: {
    ...realFacade,
    pasteTextIntoSession: (_id: string, text: string) => {
      if (!pasteOk) return false;
      pastes++;
      inputLine = text;
      return true;
    },
    sendControlU: () => {
      inputLine = "";
      return true;
    },
    sendEnterKey: () => {
      enters++;
      inputLine = "";
      markerUp = true;
      return true;
    },
    escapeInputMode: () => {},
    typeIntoSession: () => true,
    wasLastEnumerationReliable: () => true,
  },
});
mock.module("../src/daemon/session-content.js", {
  namedExports: {
    ...realContent,
    readSessionContentAsync: async () => ({
      sessionId: "s",
      name: "CaseLeaf",
      content: paneScreen(),
      lineCount: 6,
      atPrompt: false,
      paiName: "CaseLeaf",
    }),
  },
});

const RULE = "─".repeat(40);
function paneScreen(): string {
  return `${markerUp ? "◎ /goal active (3m)\n" : ""}● done\n${RULE}\n❯ ${inputLine}\n${RULE}\n`;
}

const M = await import("../src/daemon/manage.js");

const NOW = Date.now();
const entry = (over = {}) =>
  ({
    sessionId: "s",
    name: "CaseLeaf",
    objective: "x",
    pending: [],
    history: [],
    lastRearmAt: NOW - 600_000,
    // Recent enough that armIdle is false, so the arm never sends the escape
    // sequence and never needs the pane's vim mode.
    lastChangeAt: NOW - 30_000,
    lastHash: "",
    paused: false,
    startedAt: NOW - 3_600_000,
    ...over,
  }) as import("../src/daemon/manage.js").ManagedSession;

const loud = (m: { history: { what: string }[] }) => m.history.filter((h) => h.what.includes("demanded arm"));
const deferred = (m: { history: { what: string }[] }) => m.history.filter((h) => h.what.startsWith("arm deferred"));

test("forced arm over an occupied line: skipped, counts nothing, sentinel intact — and the cleared line arms", async () => {
  reset();
  inputLine = "half a sentence the operator is still typing";
  const m = entry({ lastRearmAt: 0, armFailStreak: 2 });

  const first = await M.arm(m, M.FORCED_ARM_REASON);
  assert.equal(first, "skipped");
  assert.equal(pastes, 0, "nothing typed over the operator's line");
  assert.equal(enters, 0);
  assert.equal(m.armFailStreak, 2, "a skip is not a failure");
  assert.equal(m.armFails, undefined);
  assert.equal(m.lastRearmAt, 0, "the forced-arm sentinel survives the skip");
  assert.equal(m.stuckSince, undefined);
  assert.equal(loud(m).length, 1, "the held demand is announced, once");

  // Still holding on the next attempt: said once, not every tick.
  const second = await M.arm(m, M.FORCED_ARM_REASON);
  assert.equal(second, "skipped");
  assert.equal(m.lastRearmAt, 0);
  assert.equal(loud(m).length, 1, "not repeated");

  // The operator sends or clears their line: the demanded arm goes out.
  inputLine = "";
  const third = await M.arm(m, M.FORCED_ARM_REASON);
  assert.equal(third, "armed");
  assert.equal(pastes, 1);
  assert.equal(enters, 1);
  assert.ok(m.lastRearmAt > 0, "armed for real");
  assert.equal(m.forcedArmHoldNotedAt, undefined, "the hold note is spent with the demand");
});

test("non-forced arm over an occupied line: skipped, no streak increment, deferral noted once per 5 min", async () => {
  reset();
  inputLine = "operator typing, not this time a demand";
  const m = entry({ lastRearmAt: NOW - 600_000, armFails: 1, armFailStreak: 3 });

  const first = await M.arm(m, M.GOAL_GONE_REASON);
  assert.equal(first, "skipped");
  assert.equal(m.armFailStreak, 3, "no increment");
  assert.equal(m.armFails, 1);
  assert.equal(deferred(m).length, 1);
  assert.equal(loud(m).length, 0, "no demand announcement — nothing was demanded");

  const second = await M.arm(m, M.GOAL_GONE_REASON);
  assert.equal(second, "skipped");
  assert.equal(m.armFailStreak, 3);
  assert.equal(deferred(m).length, 1, "the deferral note dedups for 5 minutes");
  assert.equal(m.forcedArmHoldNotedAt, undefined);
});

test("applyArmResult: a skipped attempt counts nothing", () => {
  const m = entry({ armFails: 2, armFailStreak: 5, lastRearmAt: NOW - 600_000 });
  M.applyArmResult(m, "skipped", NOW);
  assert.equal(m.armFails, 2);
  assert.equal(m.armFailStreak, 5);
  assert.equal(m.lastRearmAt, NOW - 600_000);
  assert.equal(m.stuckSince, undefined);
});

test("applyArmResult: an armed attempt clears the streak and the stuck marks", () => {
  const m = entry({
    armFails: 2,
    armFailStreak: 5,
    stuckSince: NOW - 60_000,
    blockedSince: NOW - 60_000,
    blockedAlertedAt: NOW - 60_000,
  });
  M.applyArmResult(m, "armed", NOW);
  assert.equal(m.armFails, 0);
  assert.equal(m.armFailStreak, 0);
  assert.equal(m.stuckSince, undefined);
  assert.equal(m.blockedSince, undefined);
  assert.equal(m.blockedAlertedAt, undefined);
});

test("stuckSince set + forced arm (lastRearmAt=0): the gate does not hold it — arm still attempted", () => {
  assert.equal(M.stuckBackoffHolds({ stuckSince: NOW - 60_000, lastRearmAt: 0 }), false);
  assert.equal(M.stuckBackoffHolds({ stuckSince: undefined, lastRearmAt: NOW - 600_000 }), false);
});

test("stuckSince set + non-forced: still skipped by the gate, as before", () => {
  assert.equal(M.stuckBackoffHolds({ stuckSince: NOW - 60_000, lastRearmAt: NOW - 600_000 }), true);
});

test("the cap fires on genuine failures but never eats a pending forced-arm sentinel", () => {
  const demanded = entry({ lastRearmAt: 0 });
  for (let i = 0; i < 5; i++) M.applyArmResult(demanded, "failed", NOW + i);
  assert.equal(demanded.lastRearmAt, 0, "a pending demanded arm survives the cap");
  assert.ok(demanded.stuckSince !== undefined, "genuine failure streak is still marked stuck");
  assert.equal(demanded.armFailStreak, 5, "the streak survives the cap reset, as before");
  assert.equal(demanded.history.filter((h) => h.what.startsWith("arming keeps failing")).length, 1);
});

test("the cap still backs off an ordinary arming by stamping lastRearmAt", () => {
  const m = entry({ lastRearmAt: NOW - 600_000 });
  M.applyArmResult(m, "failed", NOW);
  M.applyArmResult(m, "failed", NOW);
  assert.equal(m.lastRearmAt, NOW - 600_000, "under the cap, nothing is stamped");
  M.applyArmResult(m, "failed", NOW);
  assert.equal(m.lastRearmAt, NOW, "the cap stamps the backoff");
  assert.ok(m.stuckSince !== undefined);
});
