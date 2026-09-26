import "./home-guard.js";
/**
 * test/manage-pane-idle.test.ts — the arm gate's escape hatch.
 *
 * sessionIsWorking() reads any transcript movement inside WORKING_RECENT_MS as
 * "working", which is right for a mid-turn session but wrong for one whose
 * turn already ended and is now sitting on a long background shell (e.g.
 * `pai worker run`) that keeps streaming progress into the transcript for up
 * to an hour. paneLooksIdle() is what tells those two apart from the pane
 * itself: quiet long enough, nothing typed, nothing spinning.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { paneLooksIdle, PANE_IDLE_FLOOR_MS } from "../src/daemon/manage.js";

const RULE = "──────────────────────────────────────────────────────────────────";

function pane(lastLine: string, inputLine = "❯  "): string {
  return [
    lastLine,
    RULE,
    inputLine,
    RULE,
    "  👋 PAI CC 2.1.220 🧠 Opus 5 (1M context) in 📁 Example",
  ].join("\n");
}

test("empty prompt, quiet past the floor, a finished status line — idle", () => {
  const content = pane("✻ Brewed for 4m 33s · done 5:30 · 1 shell still running");
  assert.equal(paneLooksIdle(content, 6 * 60_000), true);
});

test("same pane, quiet short of the floor — not idle", () => {
  const content = pane("✻ Brewed for 4m 33s · done 5:30 · 1 shell still running");
  assert.equal(paneLooksIdle(content, 2 * 60_000), false);
});

test("a spinner line means a turn is still running, however long it's been quiet", () => {
  const content = pane("✻ Proofing… (2m 31s · ↓ 4.2k tokens)");
  assert.equal(paneLooksIdle(content, 10 * 60_000), false);
});

test("text sitting typed on the input line is never idle", () => {
  const content = pane("✻ Brewed for 4m 33s · done 5:30", "❯ some typing");
  assert.equal(paneLooksIdle(content, 10 * 60_000), false);
});

test("the terminal's own queued-messages hint means work is still waiting", () => {
  const content = pane("✻ Brewed for 4m 33s · done 5:30", "❯ Press up to edit queued messages");
  assert.equal(paneLooksIdle(content, 10 * 60_000), false);
});

test("the floor constant is five minutes", () => {
  assert.equal(PANE_IDLE_FLOOR_MS, 5 * 60_000);
});
