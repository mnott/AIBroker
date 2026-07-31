/**
 * test/dispatch-terminal.test.ts — the two screen heuristics dispatch relies on.
 *
 * Both were wrong on the first attempt, and both fail in ways that look like
 * success, so the frames below are real captures from live sessions rather than
 * invented ones:
 *
 *  - readiness: v1 waited for the screen to go QUIET. A launched session runs
 *    its `/Name … go` preamble and stays busy for minutes, so a perfectly
 *    healthy spawn timed out at 200s and reported `unreachable`.
 *  - submission: "the screen changed" is true of a busy session no matter what,
 *    so it cannot distinguish a submitted prompt from text stuck in the box.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isClaudeReady,
  hasBeenSubmitted,
  waitForReady,
  submitAndConfirm,
  type TerminalIO,
} from "../src/daemon/dispatch.js";

const RULE = "─".repeat(60);

/** A live Claude session, mid-task. Captured from the spawned Whazaa tab. */
const BUSY = `      9

✻ Vibing… (3m 27s · ↓ 11.6k tokens)

${RULE} Whazaa ──
❯
${RULE}
  👋 PAI CC 2.1.220 🧠 Opus 5 (1M context) in 📁 Whazaa
  -- INSERT -- ⏵⏵ bypass permissions on (shift+tab to cycle)`;

/** The same session, idle at its prompt. */
const IDLE = `  Done.

${RULE} Whazaa ──
❯
${RULE}
  👋 PAI CC 2.1.220 🧠 Opus 5 (1M context) in 📁 Whazaa`;

/** A bare shell — the tab exists but Claude has not drawn anything yet. */
const SHELL = `Last login: Fri Jul 31 22:43:48 on ttys012
i052341 in HKP9MJXWJY in ~/dev/ai/Whazaa
Fri 31 | 22:43:49 ➜ `;

// ── readiness ───────────────────────────────────────────────────────────────

test("a busy Claude session is READY — it queues input while it works", () => {
  // The regression that made a healthy spawn report unreachable.
  assert.equal(isClaudeReady(BUSY), true);
});

test("an idle Claude session is ready", () => {
  assert.equal(isClaudeReady(IDLE), true);
});

test("a bare shell is not ready", () => {
  assert.equal(isClaudeReady(SHELL), false);
});

test("waitForReady returns as soon as the UI appears, without waiting for quiet", async () => {
  const frames = [SHELL, SHELL, BUSY, BUSY, BUSY];
  let i = 0;
  let clock = 0;
  const io: TerminalIO = {
    capture: () => frames[Math.min(i, frames.length - 1)],
    send: () => {},
    sleep: async () => { i++; clock += 1000; },
    now: () => clock,
  };
  assert.equal(await waitForReady("S1", 200_000, io), true);
  assert.ok(clock <= 5_000, `should give up waiting for silence; took ${clock}ms`);
});

test("waitForReady times out on a tab where Claude never starts", async () => {
  let clock = 0;
  const io: TerminalIO = {
    capture: () => SHELL,
    send: () => {},
    sleep: async () => { clock += 1000; },
    now: () => clock,
  };
  assert.equal(await waitForReady("S1", 10_000, io), false);
});

// ── submission ──────────────────────────────────────────────────────────────

const typed = (text: string) => `${RULE} Whazaa ──\n❯ ${text}\n${RULE}`;
const submitted = (text: string) => `  ❯ ${text}\n\n✻ Vibing…\n\n${RULE} Whazaa ──\n❯\n${RULE}`;

test("text sitting in the input box is NOT submitted", () => {
  assert.equal(hasBeenSubmitted(typed("[Task] do the thing"), "[Task] do the thing"), false);
});

test("text that moved above an empty input box IS submitted", () => {
  assert.equal(hasBeenSubmitted(submitted("[Task] do the thing"), "[Task] do the thing"), true);
});

test("a busy screen alone does not count as submitted", () => {
  // The false positive frame-counting produces: lots of motion, nothing delivered.
  assert.equal(hasBeenSubmitted(BUSY, "[Task] do the thing"), false);
});

test("submitAndConfirm reports ok once the text lands in the transcript", async () => {
  let sent = "";
  let clock = 0;
  let polls = 0;
  const io: TerminalIO = {
    capture: () => (sent === "" ? BUSY : polls++ < 2 ? typed(sent) : submitted(sent)),
    send: (_id, t) => { sent = t; },
    sleep: async () => { clock += 500; },
    now: () => clock,
  };
  assert.equal(await submitAndConfirm("S1", "[Task] do the thing", 30_000, io), "ok");
});

test("submitAndConfirm reports no-ack when the text never leaves the box", async () => {
  let sent = "";
  let clock = 0;
  const io: TerminalIO = {
    capture: () => (sent === "" ? BUSY : typed(sent)),
    send: (_id, t) => { sent = t; },
    sleep: async () => { clock += 500; },
    now: () => clock,
  };
  assert.equal(await submitAndConfirm("S1", "[Task] do the thing", 30_000, io), "no-ack");
});

test("submitAndConfirm retries before giving up", async () => {
  let attempts = 0;
  let clock = 0;
  let sent = "";
  const io: TerminalIO = {
    capture: () => (sent && attempts >= 3 ? submitted(sent) : sent ? typed(sent) : BUSY),
    send: (_id, t) => { sent = t; attempts++; },
    sleep: async () => { clock += 500; },
    now: () => clock,
  };
  assert.equal(await submitAndConfirm("S1", "[Task] do the thing", 30_000, io), "ok");
  assert.equal(attempts, 3);
});

test("an unreadable session is reported without sending", async () => {
  const io: TerminalIO = {
    capture: () => null,
    send: () => { throw new Error("must not send into an unreadable session"); },
    sleep: async () => {},
    now: () => 0,
  };
  assert.equal(await submitAndConfirm("S1", "x", 1000, io), "unreadable");
});

test("a long multi-line body is matched on its first line, which is what shows", async () => {
  const body = "[Task] first line of a very long body that will wrap on screen\n\nmore\nlines\nhere";
  const first = "[Task] first line of a very long body that will";
  let clock = 0;
  let sent = false;
  const io: TerminalIO = {
    capture: () => (sent ? submitted(first) : BUSY),
    send: () => { sent = true; },
    sleep: async () => { clock += 500; },
    now: () => clock,
  };
  assert.equal(await submitAndConfirm("S1", body, 30_000, io), "ok");
});
