import "./home-guard.js";
/**
 * Reading the input line.
 *
 * This once blocked arming outright: if anything sat unsent in the prompt,
 * the manager stood back rather than run its goal into a half-typed
 * sentence. The terminal defeated it. Claude Code offers a greyed-out
 * SUGGESTION on that same line, accepted with Tab, and no colour survives a
 * pane capture — so a suggestion read as somebody mid-sentence, and a
 * suggestion never finishes being typed. The refusal never lifted and a
 * session sat idle with work outstanding.
 *
 * It now DOES feed a decision — inputLineDecision (test/manage-type-guard
 * .test.ts) — but not that same wall: non-empty text is only ever SKIPPED
 * and retried next tick, never blocked forever and never typed over. Only
 * once IDENTICAL text has sat unchanged for several minutes while the
 * session is idle does it read as an abandoned ghost rather than someone
 * typing, and only then is the line cleared. So a live suggestion or a real
 * half-sentence costs a delayed arming, never a permanent stall and never a
 * destroyed keystroke — which is the failure this reading originally caused.
 *
 * These tests pin what the raw reading itself reports, and above all that it
 * finds the LIVE line rather than scrollback — a wrong answer here now feeds
 * a wrong decision instead of a confusing log entry.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promptUnsentText, promptHasUnsentText, typedLineMatches } from "../src/daemon/manage.js";

const RULE = "──────────────────────────────────────────────────────────────────";
const TITLED_RULE = "─────────────────────────────────────────────── Example ──";

/** A pane as it reads while the session works, with the given input line. */
function pane(inputLine: string, scrollback = "", rule = RULE): string {
  return [
    scrollback,
    "✻ Cerebrating… (19m 0s · ↓ 30.8k tokens)",
    rule,
    inputLine,
    RULE,
    "  👋 PAI CC 2.1.220 🧠 Opus 5 (1M context) in 📁 Example",
  ].join("\n");
}

test("an empty prompt reports nothing", () => {
  assert.equal(promptUnsentText(pane("❯  ")), null);
  assert.equal(promptHasUnsentText(pane("❯  ")), false);
});

test("text on the line is reported verbatim", () => {
  assert.equal(
    promptUnsentText(pane("❯ do the member route for the bar names")),
    "do the member route for the bar names",
  );
});

test("a rule carrying a title still frames the input line", () => {
  // The box is drawn with the session's name in the border; the line beneath
  // it is still the live prompt, and missing that was why the reading failed.
  assert.equal(promptUnsentText(pane("❯ keep going", "", TITLED_RULE)), "keep going");
});

test("the terminal's own queued-input hint is not operator text", () => {
  assert.equal(promptUnsentText(pane("❯ Press up to edit queued messages")), null);
});

test("commands already run are scrollback, not the live line", () => {
  const scrollback = ["  ❯ /clear", "  ❯ /goal do the thing"].join("\n");
  assert.equal(promptUnsentText(pane("❯  ", scrollback)), null);
});

test("a prompt holding only whitespace reports nothing", () => {
  assert.equal(promptUnsentText(pane("❯      ")), null);
});

test("no prompt box at all — nothing is claimed", () => {
  assert.equal(promptUnsentText("just some output\nand more output"), null);
});

test("prose beginning with a dash is not mistaken for the box rule", () => {
  const notARule = ["- a bullet point about something", "❯ not the live line"].join("\n");
  assert.equal(promptUnsentText(notARule), null);
});

// 2026-10-06: a /goal longer than the pane wraps inside the input box; the
// read-back used to be only the first visual line, so arm() aborted.
const WRAP_RULE = "─".repeat(60);
const GOAL = "/goal Follow ~/.aibroker/manage-briefs/caseleaf.md until done, keep the worklist in order, report every finding to the operator, and never stop before the shift ends.";
const wrapCapture = (...rows: string[]) =>
  ["  some scrollback", WRAP_RULE, `❯ ${rows[0]}`, ...rows.slice(1).map((r) => `  ${r}`), WRAP_RULE, "  ? for shortcuts"].join("\n");

test("promptUnsentText: wrapped goal reads back whole across 3 lines", () => {
  const pane = wrapCapture(GOAL.slice(0, 62), GOAL.slice(63, 128), GOAL.slice(129));
  const got = promptUnsentText(pane);
  assert.equal(got, GOAL);
  assert.equal(typedLineMatches(got!, GOAL), true);
});

test("typedLineMatches: mid-word wrap matches", () => {
  const got = promptUnsentText(wrapCapture(GOAL.slice(0, 70), GOAL.slice(70)))!;
  assert.notEqual(got, GOAL);
  assert.equal(typedLineMatches(got, GOAL), true);
});

test("typedLineMatches: mangled wrapped line does not match", () => {
  const mangled = "l " + GOAL.slice(6);
  const got = promptUnsentText(wrapCapture(mangled.slice(0, 62), mangled.slice(63)))!;
  assert.equal(typedLineMatches(got, GOAL), false);
});

const STALE_BOX = [RULE, "❯ just be sure to be clever on the", RULE].join("\n");

test("a stale box with text above an empty live box reports nothing", () => {
  assert.equal(promptUnsentText(pane("❯", STALE_BOX)), null);
});

test("a stale box above a live box holding other text reports the live text", () => {
  assert.equal(promptUnsentText(pane("❯ live text", STALE_BOX)), "live text");
});
