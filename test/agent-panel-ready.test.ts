/**
 * test/agent-panel-ready.test.ts — a session running background agents is
 * still a live Claude prompt.
 *
 * With agents out, Claude draws a panel UNDER its status lines: a "main"
 * header, one row per agent, an overflow count and a navigation hint. That is
 * up to a dozen lines below the closing rule, and the readiness check used to
 * read them as a shell having pushed the box up the screen. Observed live on
 * 2026-09-03: a managed session with seven agents running was refused every
 * send as "at a shell prompt", and its manager could not arm it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isClaudeReady } from "../src/transport/screen.js";

const RULE = "─".repeat(60);

/** Captured from a live pane, names replaced with the project's own vocabulary. */
const WITH_AGENTS = `⏺ [2026-09-03 01:56] Wiring in its gate. Waiting.

✻ Waiting for 2 background agents to finish
                                            94% context used · ◎ /goal active (4h)
${RULE} project ─
❯
${RULE}
  👋 PAI CC 2.1.258 🧠 Fable 5.1 in 📁 project                              /rc
  🔌 MCPs: Aibroker, Clickr, Coogle, Devonthink, Dtp, Hook, Jobs
            macOS, PAI, Scribe, Seriousletter, Teams, Todoist, Webfetch
  💎 Context: 920K / 1000K (0%) │ 5h: 31% → 04:10 │ 1d: 6% / 30% │ 7d: 32% → Sa. 08:00
  -- INSERT -- ↑/↓ to select · Enter to view

❯ ⏺ main
  ◯ engineer  Running tools/install.sh --check compile gate        18m 23s · ↓ 182.8k tokens
  ◯ engineer  Running tools/install.sh --check                     18m 12s · ↓ 158.9k tokens
  ◯ engineer  Waiting on warm-up xcodebuild build                   10m 3s · ↓ 162.2k tokens
  ◯ engineer  Checking git status of new Catalogue files             7m 4s · ↓ 148.1k tokens
  ◯ engineer  Running install.sh --check compile gate              16m 39s · ↓ 140.6k tokens
  ↓ 2 more`;

/** The same pane after Claude exited: the panel is gone and a shell has the tty. */
const EXITED_UNDER_PANEL = `${WITH_AGENTS}
Sat 03 | 02:01:12 ️ ➜`;

test("a live prompt with the background-agents panel expanded is ready", () => {
  assert.equal(isClaudeReady(WITH_AGENTS), true);
});

test("a shell prompt under the panel is still NOT ready", () => {
  assert.equal(isClaudeReady(EXITED_UNDER_PANEL), false);
});

test("a shell filling the screen below the box is still NOT ready", () => {
  const filler = Array.from({ length: 12 }, (_, i) => `line ${i} of shell output`).join("\n");
  const frame = `${RULE}\n❯\n${RULE}\n  👋 PAI\n${filler}\n➜`;
  assert.equal(isClaudeReady(frame), false);
});
