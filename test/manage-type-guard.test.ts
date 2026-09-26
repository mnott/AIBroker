import "./home-guard.js";
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
 *
 * `isClaudePane` is the shell-vs-session guard behind manage's creation
 * check and arm(): idle Claude tabs report "(claude)", busy ones "(node)",
 * and only a bare shell's title names neither — atPrompt alone misread a
 * live but idle session as a shell (2026-09-17).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { inputLineDecision, typedLineMatches, needsVimEscape, isClaudePane } from "../src/daemon/manage.js";

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

// The 2026-09-18 failure: a real terminal wraps long input lines, so the
// read-back carries the intended text broken across pane lines with
// continuation indent. That is wrapping, not corruption — it must match.

test("typedLineMatches: wrapped across three lines with deep continuation indent still matches", () => {
  const intended = "/goal fix the MCP remoting for Chrome tabs";
  const readBack = "/goal fix the MCP\n              remoting for\n              Chrome tabs";
  assert.equal(typedLineMatches(readBack, intended), true);
});

test("typedLineMatches: ❯ marker plus a wrapped fold still matches", () => {
  const intended = "/goal fix the MCP remoting for Chrome tabs";
  const readBack = "❯ /goal fix the MCP remoting\n  for Chrome tabs";
  assert.equal(typedLineMatches(readBack, intended), true);
});

test("typedLineMatches: wrapped read-back with different words does not match", () => {
  const intended = "/goal fix the MCP remoting for Chrome tabs";
  const readBack = "❯ /goal fix the MCP remoting for\n    Firefox tabs";
  assert.equal(typedLineMatches(readBack, intended), false);
});

test("typedLineMatches: wrapped but truncated read-back does not match", () => {
  const intended = "/goal fix the MCP remoting for Chrome tabs";
  const readBack = "❯ /goal fix the MCP\n    remoting for Chr";
  assert.equal(typedLineMatches(readBack, intended), false);
});

// The 2026-09-20 failure: Claude Code scrolls long input lines so only the
// tail is visible, or collapses the paste into a placeholder "[Pasted text
// #N]" followed by the tail. Both are sufficient evidence of a successful
// paste; tail matches are now accepted.

test("typedLineMatches: scrolled tail of a very long line matches", () => {
  const LONG = "/goal AG2. msg=kind line+k=v lines. kinds T R S Q A X. keys " + "x".repeat(480) + " YOUR CONTROLS until 15:40 and get on with what does not need the screen.";
  const readBack = "❯ n with what does not need the screen.";
  assert.equal(typedLineMatches(readBack, LONG), true);
});

test("typedLineMatches: collapsed paste placeholder plus tail matches", () => {
  const LONG = "/goal AG2. msg=kind line+k=v lines. kinds T R S Q A X. keys " + "x".repeat(480) + " YOUR CONTROLS until 15:40 and get on with what does not need the screen.";
  const readBack = "[Pasted text #8]n with what does not need the screen.";
  assert.equal(typedLineMatches(readBack, LONG), true);
});

test("typedLineMatches: collapsed paste placeholder alone (empty after strip) matches", () => {
  const LONG = "/goal AG2. msg=kind line+k=v lines. kinds T R S Q A X. keys " + "x".repeat(480) + " YOUR CONTROLS until 15:40 and get on with what does not need the screen.";
  const readBack = "[Pasted text #8]";
  assert.equal(typedLineMatches(readBack, LONG), true);
});

test("typedLineMatches: an empty read-back with no placeholder does not match — nothing was pasted", () => {
  const LONG = "/goal AG2. msg=kind line+k=v lines. kinds T R S Q A X. keys " + "x".repeat(480) + " YOUR CONTROLS until 15:40 and get on with what does not need the screen.";
  assert.equal(typedLineMatches("", LONG), false);
  assert.equal(typedLineMatches("❯ ", LONG), false);
});

test("typedLineMatches: a short tail (< 30 chars) does not match", () => {
  const LONG = "/goal AG2. msg=kind line+k=v lines. kinds T R S Q A X. keys " + "x".repeat(480) + " YOUR CONTROLS until 15:40 and get on with what does not need the screen.";
  const readBack = "the screen.";
  assert.equal(typedLineMatches(readBack, LONG), false);
});

test("typedLineMatches: a tail of a different line does not match", () => {
  const LONG = "/goal AG2. msg=kind line+k=v lines. kinds T R S Q A X. keys " + "x".repeat(480) + " YOUR CONTROLS until 15:40 and get on with what does not need the screen.";
  const readBack = "n with what does not need the keyboard.";
  assert.equal(typedLineMatches(readBack, LONG), false);
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

// ── isClaudePane ──────────────────────────────────────────────────────────
//
// The guard that keeps manage from refusing a live but IDLE Claude session:
// iTerm tab titles encode the foreground process, so "(claude)" is the idle
// session and "(node)" a busy one; a title naming neither is a shell.

test("isClaudePane: an idle Claude tab is the session", () => {
  assert.equal(isClaudePane("✳ PAI (claude)"), true);
});

test("isClaudePane: a busy Claude tab (node) is the session", () => {
  assert.equal(isClaudePane("Chat (node)"), true);
});

test("isClaudePane: a bare zsh title is a shell", () => {
  assert.equal(isClaudePane("~/dev/ai/PAI (-zsh)"), false);
});

test("isClaudePane: any node foreground process is not a shell", () => {
  assert.equal(isClaudePane("exec (node)"), true);
});

test("isClaudePane: no title at all is not a Claude pane", () => {
  assert.equal(isClaudePane(undefined), false);
});
