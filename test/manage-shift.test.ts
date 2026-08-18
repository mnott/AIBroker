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
import { parseShift, shiftObjective } from "../src/daemon/manage.js";

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
