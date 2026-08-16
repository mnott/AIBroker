/**
 * Reading the input line — for the record, not for a decision.
 *
 * This once blocked arming: if anything sat unsent in the prompt, the manager
 * stood back rather than run its goal into a half-typed sentence. The terminal
 * defeated it. Claude Code offers a greyed-out SUGGESTION on that same line,
 * accepted with Tab, and no colour survives a pane capture — so a suggestion
 * read as somebody mid-sentence, and a suggestion never finishes being typed.
 * The refusal never lifted and a session sat idle with work outstanding.
 *
 * The reading is kept because it explains a goal that arrives welded to
 * somebody's half-sentence, and it decides nothing. These tests pin what it
 * reports, and above all that it finds the LIVE line rather than scrollback —
 * a wrong answer here now costs a confusing log entry instead of a stall.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promptUnsentText, promptHasUnsentText } from "../src/daemon/manage.js";

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
