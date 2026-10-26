import "./home-guard.js";
/**
 * test/screen-claude-ready.test.ts — a usage window rolling must not kill a session.
 *
 * The PAI statusline's usage row ends in a reset time (`7d: 1% → Sa. 08:00`)
 * except right after a window rolls, when there is no suffix yet and the row
 * ends bare (`7d: 1%`) — which is also a perfect shell-prompt shape for
 * `[➜$%#»]$`. On 2026-09-27 both 07:00 sweep sessions were read as "at a
 * shell" for exactly that, their tasks parked, and the day's runs silently
 * never happened.
 *
 * The frames below mirror that morning's captures structurally, with names,
 * paths and MCP lists neutralized.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isClaudeReady } from "../src/transport/screen.js";

const RULE = "─".repeat(62);

/** A live session whose 7-day window just rolled: the usage row ends bare `1%`. */
const LIVE_ROLLED = `⏺ Calling aibroker…
${RULE} project ─
❯
${RULE}
  👋 PAI CC 🧠 Opus in 📁 project • worklist
  🔌 MCPs: 14: Aibroker, PAI, macOS, Hook +10
  💎 Context: 730K / 1000K (5% left, 54K) │ 5h: 1% → 15:10 │ 1d: 0% / 14% │ 7d: 1%
  🐝 provider
  -- INSERT -- ⏵⏵ bypass permissions on (shift+tab to cycle) · ← 3 agents`;

/** The same pane once the window has its reset time back — always worked. */
const LIVE_WITH_RESET = LIVE_ROLLED.replace("7d: 1%\n", "7d: 1% → Sa. 08:00\n");

/** A dead box with a zsh prompt underneath: the shape the guard exists for. */
const DEAD_BOX_SHELL_ZSH = `${RULE} project ─
❯
${RULE}
  👋 PAI CC 🧠 Opus in 📁 project
✦ Sat 27 | 07:02:31 ️ ➜`;

/** The same, with a bare `%` prompt (zsh's default). */
const DEAD_BOX_SHELL_PCT = `${RULE} project ─
❯
${RULE}
  👋 PAI CC 🧠 Opus in 📁 project
%`;

test("a live session whose usage line ends bare `7d: 1%` is READY", () => {
  // The 2026-09-27 regression: the rolled window's missing suffix made a
  // healthy session look like a shell.
  assert.equal(isClaudeReady(LIVE_ROLLED), true);
});

test("the same frame with the reset-time suffix stays READY", () => {
  assert.equal(isClaudeReady(LIVE_WITH_RESET), true);
});

test("even a truncated capture ending ON the bare `%` statusline row is READY", () => {
  // Bottom rows not captured: the usage row is the last line on screen. Its
  // length and furniture must disqualify it, not just its position.
  const truncated = LIVE_ROLLED.split("\n").slice(0, -2).join("\n");
  assert.equal(isClaudeReady(truncated), true);
});

test("a real zsh prompt under a dead box is NOT ready", () => {
  assert.equal(isClaudeReady(DEAD_BOX_SHELL_ZSH), false);
});

test("a bare `%` prompt under a dead box is NOT ready", () => {
  assert.equal(isClaudeReady(DEAD_BOX_SHELL_PCT), false);
});
