/**
 * test/manage-shift.test.ts — reading a night's work out of one sentence.
 *
 * A shift is the paragraph the operator used to type by hand, reduced to three
 * variables. The failure to prevent is not a crash: it is a shift that lasts a
 * different length than the one that was said, or that hands over the screen
 * because nobody explicitly withheld it. Both are silent, and both are only
 * discovered by coming back to a machine that did the wrong thing all night.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseShift, shiftObjective, screenLease, parseUntilClock } from "../src/daemon/manage.js";
import type { ManagedSession } from "../src/daemon/manage.js";

// ── how long ─────────────────────────────────────────────────────────────────

test("hours are read however they are written", () => {
  for (const s of ["for 8 hours", "8h", "8 hrs", "eight hours later — 8 h"]) {
    assert.equal(parseShift(s).hours, 8, s);
  }
});

test("minutes work, and a fraction of an hour is not rounded away", () => {
  assert.equal(parseShift("for 90 minutes").hours, 1.5);
  assert.equal(parseShift("30 min").hours, 0.5);
});

test("no length named is a working night, not forever", () => {
  assert.equal(parseShift("work the issues, your controls").hours, 8);
});

test("a shift cannot run longer than a day by accident", () => {
  // "for 100 hours" is a typo or a misread, never an intention.
  assert.equal(parseShift("for 100 hours").hours, 24);
  assert.equal(parseShift("for 0 hours").hours, 0.25, "nor can it be instantly over");
});

// ── the screen ───────────────────────────────────────────────────────────────

test("the screen is withheld unless it was actually offered", () => {
  // The dangerous default is the other way round: a shift that takes the
  // pointer because nobody said not to would drive the machine while somebody
  // is using it.
  assert.equal(parseShift("work the issues for 8 hours").visual, false);
  assert.equal(parseShift("8 hours, your controls").visual, true);
  assert.equal(parseShift("8 hours with controls").visual, true);
});

test("withholding beats granting when both are said", () => {
  // "your controls, but I need the screen" is a person changing their mind
  // mid-sentence, and the safe reading is the restrictive one.
  assert.equal(parseShift("your controls — actually no screen, I need it").visual, false);
});

// ── how many ─────────────────────────────────────────────────────────────────

test("workers are read from the sentence and default to one", () => {
  assert.equal(parseShift("8h").workers, 1);
  assert.equal(parseShift("8h, 2 workers").workers, 2);
  assert.equal(parseShift("8h, maximum of 3").workers, 3);
  assert.equal(parseShift("8h, up to 4 sessions").workers, 4);
});

test("the worker count is bounded at both ends", () => {
  assert.equal(parseShift("0 workers").workers, 1);
  assert.equal(parseShift("400 workers").workers, 8);
});

// ── the sentence the operator will actually say ──────────────────────────────

test("the whole thing, as it will be said out loud", () => {
  const s = parseShift("ok you are free to work on the issues for 8 hours with your controls, at a maximum of 2 workers or so");
  assert.deepEqual(s, { hours: 8, visual: true, workers: 2 });
});

// ── the objective ────────────────────────────────────────────────────────────

test("the objective is one line, because a newline submits it", () => {
  assert.ok(!shiftObjective().includes("\n"));
});

test("the objective carries the claim read-back, which is the part that cannot be dropped", () => {
  // Two workers on one issue is not detected until the merge, by which time
  // both have spent hours. The re-read is the whole protocol.
  assert.match(shiftObjective(), /RE-READ/);
  assert.match(shiftObjective(), /fast-forward/);
});

// ── the verb must not swallow an objective ───────────────────────────────────

test("only the word shift starts a shift", () => {
  // "work through the open items first" is how half of all objectives begin.
  // An earlier version accepted "go" and "work" as the verb, which would have
  // silently replaced a typed objective with the issue-driven one — a failure
  // nobody would notice until the session was doing different work all night.
  const VERB = /^shift\b\s*([\s\S]*)$/i;
  assert.ok(VERB.test("shift 8h your controls"));
  assert.ok(VERB.test("shift off"));
  assert.equal(VERB.test("work through the open items first"), false);
  assert.equal(VERB.test("go through the bug list in order"), false);
  assert.equal(VERB.test("shifting the panel left is the fix"), false, "a word that merely starts with shift is not the verb");
});

// ── who holds the screen, and until when ─────────────────────────────────────

const NOW = Date.parse("2026-08-19T09:00:00.000Z");
const HOUR = 3_600_000;

function session(over: Partial<ManagedSession>): ManagedSession {
  return {
    sessionId: "s", name: "example", objective: "work", pending: [], history: [],
    lastHash: "", lastChangeAt: NOW, lastRearmAt: NOW, startedAt: NOW - 10 * HOUR,
    ...over,
  } as ManagedSession;
}

test("a shift with the screen leases it for the length of the shift", () => {
  const lease = screenLease(session({
    shift: { until: NOW + 5 * HOUR, workers: 1, visual: true, startedAt: NOW - HOUR },
    screenSince: NOW - HOUR,
  }), NOW);
  assert.deepEqual(lease, { until: NOW + 5 * HOUR, since: NOW - HOUR });
});

test("a shift without the screen leases nothing", () => {
  // The screen is withheld unless it was offered; the lease must not invent it.
  const lease = screenLease(session({
    noScreen: true,
    shift: { until: NOW + 5 * HOUR, workers: 1, visual: false, startedAt: NOW - HOUR },
  }), NOW);
  assert.equal(lease, null);
});

test("`hands on for eight hours` is a lease too, not only a shift", () => {
  // Two ways to hand the screen over, one rule. A renewal that only knew about
  // shifts would silently not apply to the other half of the interface.
  const lease = screenLease(session({ handsUntil: NOW + 8 * HOUR, screenSince: NOW }), NOW);
  assert.deepEqual(lease, { until: NOW + 8 * HOUR, since: NOW });
});

test("a timed hold — the operator taking the machine — is not a lease", () => {
  const lease = screenLease(session({ noScreen: true, handsUntil: NOW + HOUR }), NOW);
  assert.equal(lease, null);
});

test("an expired lease is over, and is not renewed one last time", () => {
  assert.equal(screenLease(session({ handsUntil: NOW - 60_000, screenSince: NOW - HOUR }), NOW), null);
  assert.equal(screenLease(session({
    shift: { until: NOW - 60_000, workers: 1, visual: true, startedAt: NOW - 9 * HOUR },
  }), NOW), null);
});

// ── an end time, not a length ────────────────────────────────────────────────

test("`until 08:00` said at midnight means this morning", () => {
  // The arithmetic this replaces is done at the exact moment somebody is too
  // tired to do it, and a slip lands as a permission that ends in the dark.
  const midnight = new Date("2026-08-19T00:10:00");
  assert.equal(parseUntilClock("until 08:00", midnight), new Date("2026-08-19T08:00:00").getTime());
});

test("`until 08:00` said at nine means tomorrow, not eleven hours ago", () => {
  const morning = new Date("2026-08-19T09:00:00");
  assert.equal(parseUntilClock("until 08:00", morning), new Date("2026-08-20T08:00:00").getTime());
});

test("till, til, bare hours and am/pm all read", () => {
  const at = new Date("2026-08-19T00:10:00");
  const eight = new Date("2026-08-19T08:00:00").getTime();
  for (const s of ["until 8", "till 8", "til 08:00", "until 8am"]) {
    assert.equal(parseUntilClock(s, at), eight, s);
  }
  assert.equal(parseUntilClock("until 8pm", at), new Date("2026-08-19T20:00:00").getTime());
});

test("nonsense on the clock is not a time", () => {
  const at = new Date("2026-08-19T00:10:00");
  assert.equal(parseUntilClock("until 33:00", at), null);
  assert.equal(parseUntilClock("until 8:99", at), null);
  assert.equal(parseUntilClock("work the issues", at), null);
  assert.equal(parseUntilClock("this is futile", at), null, "a word containing til is not the word");
});

test("a shift can be given an end time instead of a length", () => {
  const at = new Date("2026-08-19T00:00:00");
  assert.equal(parseShift("until 08:00, your controls", at).hours, 8);
  assert.equal(parseShift("until 08:00, your controls", at).visual, true);
});

test("an end time beats a length when both are said", () => {
  // Somebody who said both meant the end; the length is how they got there.
  const at = new Date("2026-08-19T00:00:00");
  assert.equal(parseShift("for 2 hours, until 08:00", at).hours, 8);
});
