import "./home-guard.js";
/**
 * Claude Code idle at its prompt with the placeholder suggestion in the box
 * (tmux capture-pane -p -J, Linux, Claude Code 2.1.148) must read as idle.
 * `aibroker sessions` showed it busy: tmux only sees the `claude` process.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isClaudeReady, isInputBoxEmpty, isClaudeTitleIdle } from "../src/transport/screen.js";

const frame = readFileSync(new URL("./fixtures/claude-idle-placeholder-pane.txt", import.meta.url), "utf-8");

test("placeholder prompt frame is ready and empty", () => {
  assert.equal(isClaudeReady(frame), true);
  assert.equal(isInputBoxEmpty(frame), true);
});

test("✳ title is idle, spinner title is busy", () => {
  assert.equal(isClaudeTitleIdle("✳ Claude Code"), true);
  assert.equal(isClaudeTitleIdle("⠂ Claude Code"), false);
  assert.equal(isClaudeTitleIdle(null), false);
});

import { tmuxAtPrompt } from "../src/transport/sync-facade.js";

// A launched pane: title pinned to the session name, so no ✳ marker.
const launched = (id: string) => ({ id, name: "demo", tabTitle: "demo", tty: null, busy: true, transport: "tmux" as const, command: "claude" });

test("launched pane with pinned title and idle content is idle", () => {
  assert.equal(tmuxAtPrompt(launched("idle-1"), () => frame), true);
});

test("launched pane with working content is busy", () => {
  const working = frame.replace(/\n+$/, "") + "\n✻ Pondering… (12s · ↓ 300 tokens · esc to interrupt)\n";
  assert.equal(tmuxAtPrompt(launched("work-1"), () => working), false);
});

test("capture failure falls back to the ✳ title rule", () => {
  assert.equal(tmuxAtPrompt({ ...launched("fb-1"), tabTitle: "✳ demo" }, () => null), true);
  assert.equal(tmuxAtPrompt(launched("fb-2"), () => null), false);
});
