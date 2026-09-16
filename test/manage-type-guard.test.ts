/**
 * test/manage-type-guard.test.ts — the read-back-first typing sequence, as
 * two pure decisions.
 *
 * `inputLineDecision` is the policy behind arm() and send_to_session: never
 * type over live input, never clear on sight. An outright refusal was tried
 * once, reverted (see test/manage-unsent-prompt.test.ts's own header — a
 * terminal's greyed-out Tab-completion suggestion cannot be told apart from
 * someone mid-sentence in a captured pane), and a later pass of the SAME
 * change reinstated that exact refusal and had to be corrected again mid
 * -flight. So text is only ever SKIPPED and retried next tick, unless the
 * IDENTICAL text has sat there for GHOST_TICKS consecutive ticks (2 minutes)
 * while the session is idle — at which point it reads as an abandoned ghost
 * rather than a live sentence, and only then is it cleared.
 *
 * `typedLineMatches` is the read-back verification: after typing (no Enter
 * yet), read the pane again and confirm it actually shows what was typed
 * before sending CR — catching, among other things, a long `/goal …` line
 * observed folding in the terminal and landing as a pasted message instead
 * of a slash command (2026-09-13).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { inputLineDecision, typedLineMatches, needsVimEscape } from "../src/daemon/manage.js";

// ── inputLineDecision ────────────────────────────────────────────────────

test("empty input line — type immediately", () => {
  const result = inputLineDecision({ text: "", sameForTicks: 1, idle: true });
  assert.equal(result.action, "type");
});

test("new (never-before-seen) text — skip, never clear", () => {
  const result = inputLineDecision({ text: "/goal clear", sameForTicks: 1, idle: true });
  assert.equal(result.action, "skip");
});

test("identical text for 6 ticks while idle — clear-then-type, with evidence logged", () => {
  const result = inputLineDecision({ text: "/goal clear", sameForTicks: 6, idle: true, idleMs: 134_000, band: "warm-up" });
  assert.equal(result.action, "clear-then-type");
  assert.ok(result.logCleared);
  assert.match(result.logCleared!, /\/goal clear/);
  assert.match(result.logCleared!, /identical for 6 ticks/);
  assert.match(result.logCleared!, /idle 134s/);
  assert.match(result.logCleared!, /band=warm-up/);
});

test("identical text for 6 ticks but NOT idle — still skip", () => {
  const result = inputLineDecision({ text: "/goal clear", sameForTicks: 6, idle: false });
  assert.equal(result.action, "skip");
});

test("text that changes between ticks — caller resets sameForTicks, still skip", () => {
  // The caller is responsible for detecting a change and resetting
  // sameForTicks to 1 — this is what that reset looks like from
  // inputLineDecision's side, and it must never reach clear-then-type.
  const result = inputLineDecision({ text: "something else now", sameForTicks: 1, idle: true });
  assert.equal(result.action, "skip");
});

// ── typedLineMatches ─────────────────────────────────────────────────────

test("typedLineMatches: exact match", () => {
  assert.equal(typedLineMatches("/goal do the thing", "/goal do the thing"), true);
});

test("typedLineMatches: tolerant of a leading ❯ prompt marker and trailing whitespace", () => {
  assert.equal(typedLineMatches("❯ /goal do the thing   ", "/goal do the thing"), true);
});

test("typedLineMatches: a folded/truncated read-back does not match — the 2026-09-13 failure", () => {
  // The line folded in the terminal and landed as something else entirely —
  // not a prefix relationship in either direction.
  assert.equal(typedLineMatches("❯ do the thing (pasted as a message)", "/goal do the thing"), false);
});

test("typedLineMatches: a shorter read-back than intended does not match", () => {
  assert.equal(typedLineMatches("❯ /goal do the th", "/goal do the thing"), false);
});

// ── needsVimEscape ───────────────────────────────────────────────────────
//
// Gates escapeInputMode's 'i' keystroke — sent unconditionally, it lands as
// a literal character on a pane WITHOUT vim mode enabled (no colour survives
// a pane capture to distinguish "modal command" from "typed text" any more
// than it does for a Tab-completion suggestion), which the read-back above
// would then never match — aborting every arming forever, silently, on any
// non-vim session. Only the presence of the status indicator itself may
// authorize sending it.

test("needsVimEscape: pane showing -- INSERT -- needs the escape", () => {
  assert.equal(needsVimEscape("some pane content\n-- INSERT --\n❯ "), true);
});

test("needsVimEscape: pane showing -- NORMAL -- needs the escape", () => {
  assert.equal(needsVimEscape("some pane content\n-- NORMAL --\n❯ "), true);
});

test("needsVimEscape: a plain prompt with no mode indicator does not", () => {
  assert.equal(needsVimEscape("some pane content\n❯ "), false);
});
