import "./home-guard.js";
/**
 * Claude Code 2.1.284 idle with the PAI statusline (four custom rows below the
 * input box). The pane must stay a Claude session (kind claude) and read idle;
 * the same frame with a spinner line above the box reads busy.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isClaudeReady, isInputBoxEmpty, isClaudeFrameIdle } from "../src/transport/screen.js";
import { tmuxAtPrompt } from "../src/transport/sync-facade.js";

const frame = readFileSync(new URL("./fixtures/claude-idle-statusline-pane.txt", import.meta.url), "utf-8");
const old = readFileSync(new URL("./fixtures/claude-idle-placeholder-pane.txt", import.meta.url), "utf-8");
// Spinner line sits above the input box, exactly where Claude draws it.
const working = frame.replace(/\n(─{20,}\n❯)/, "\n✻ Pondering… (12s · ↓ 300 tokens · esc to interrupt)\n\n$1");

const pane = (id: string) => ({ id, name: "demo", tabTitle: "demo", tty: null, busy: true, transport: "tmux" as const, command: "claude" });

test("statusline frame is ready, empty and idle", () => {
  assert.equal(isClaudeReady(frame), true);
  assert.equal(isInputBoxEmpty(frame), true);
  assert.equal(isClaudeFrameIdle(frame), true);
});

test("statusline frame with a spinner line is busy but still ready", () => {
  assert.notEqual(working, frame);
  assert.equal(isClaudeFrameIdle(working), false);
  assert.equal(isClaudeReady(working), true);
  assert.equal(tmuxAtPrompt(pane("sl-work"), () => working), false);
});

test("statusline pane is idle via tmuxAtPrompt; old fixture stays idle", () => {
  assert.equal(tmuxAtPrompt(pane("sl-idle"), () => frame), true);
  assert.equal(isClaudeFrameIdle(old), true);
});

test("idle claude pane snapshots as isClaude (kind claude), a shell pane does not", async () => {
  const { tmuxToSnapshot } = await import("../src/transport/sync-facade.js");
  assert.equal(tmuxToSnapshot({ ...pane("sl-snap"), busy: false }).isClaude, true);
  assert.equal(tmuxToSnapshot({ ...pane("sl-sh"), busy: false, command: "bash" }).isClaude, undefined);
});
