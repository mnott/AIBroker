/**
 * Never type over somebody mid-sentence.
 *
 * The manager pastes into the same input line a person types into, and sends a
 * backspace first to escape vi normal mode — so arming over half-typed text
 * eats a character of it and runs the two together as one prompt. This test
 * pins the detector that prevents it, in both directions: a false negative
 * mangles the operator's sentence, a false positive stops the session ever
 * being armed again. The second is the quieter failure, so the empty-prompt
 * cases matter as much as the occupied ones.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promptHasUnsentText } from "../src/daemon/manage.js";

const RULE = "──────────────────────────────────────────────────────────────────";

/** A pane as it reads while the session works, with an empty input line. */
function pane(inputLine: string, scrollback = ""): string {
  return [
    scrollback,
    "✻ Cerebrating… (19m 0s · ↓ 30.8k tokens)",
    RULE,
    inputLine,
    RULE,
    "  👋 PAI CC 2.1.220 🧠 Opus 5 (1M context) in 📁 Example",
  ].join("\n");
}

test("an empty prompt is free to type into", () => {
  assert.equal(promptHasUnsentText(pane("❯  ")), false);
});

test("a half-typed sentence blocks arming", () => {
  assert.equal(promptHasUnsentText(pane("❯ keep going with the rotated OCR, the origin is")), true);
});

test("the terminal's own queued-input hint is not the operator's text", () => {
  assert.equal(promptHasUnsentText(pane("❯ Press up to edit queued messages")), false);
});

test("commands already run are scrollback, not unsent input", () => {
  // The `❯ /clear` lines sit above the rules; only the enclosed line is live.
  const scrollback = ["  ❯ /clear", "  ❯ /clear", "  ❯ /goal do the thing"].join("\n");
  assert.equal(promptHasUnsentText(pane("❯  ", scrollback)), false);
});

test("a prompt holding only whitespace counts as empty", () => {
  assert.equal(promptHasUnsentText(pane("❯      ")), false);
});

test("no prompt box at all — nothing is claimed", () => {
  assert.equal(promptHasUnsentText("just some output\nand more output"), false);
});
