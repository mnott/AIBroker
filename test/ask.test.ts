/**
 * test/ask.test.ts — probing a session for liveness.
 *
 * Two traps drive these tests:
 *
 *  - Claude echoes the question into its transcript, so the naive "what is new
 *    on screen" reads the question back as the answer. PAI predicted this as
 *    the inverse of the `❯`-marker trap in dispatch; it is real.
 *  - Claude QUEUES input while mid-turn, so a busy-but-healthy session cannot
 *    answer and looks identical to a wedged one. Liveness is therefore decided
 *    before anything is sent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ask, extractReply, type AskDeps } from "../src/daemon/ask.js";
import type { PaiProject } from "../src/daemon/pai-projects.js";
import type { TerminalIO } from "../src/daemon/terminal-screen.js";

const RULE = "─".repeat(60);

const project = (over: Partial<PaiProject> = {}): PaiProject => ({
  name: "jobs-matthias",
  names: ["jobs-matthias"],
  slug: "jobs-matthias",
  displayName: "Jobs Matthias",
  rootPath: "/jobs",
  sessionCount: 0,
  lastActive: "",
  ...over,
});

const live = (label: string) => [{ id: "S1", name: label, paiName: label }];

/** An idle Claude prompt showing `transcript` above an empty input box. */
const screen = (transcript: string) =>
  `${transcript}\n${RULE} Jobs Matthias ──\n❯\n${RULE}\n  👋 PAI CC 2.1.220`;

/**
 * A scripted terminal. Frames advance one per poll; the last repeats, which is
 * what "settled" looks like.
 */
function fake(frames: string[], onSend?: (t: string) => string[]) {
  let seq = [...frames];
  let i = 0;
  let clock = 0;
  const sent: string[] = [];
  const io: TerminalIO = {
    capture: () => seq[Math.min(i, seq.length - 1)],
    send: (_id, t) => { sent.push(t); if (onSend) { seq = onSend(t); i = 0; } },
    sleep: async (ms) => { clock += ms; i++; },
    now: () => clock,
  };
  return { io, sent: () => sent };
}

function deps(io: TerminalIO, over: Partial<AskDeps> = {}): AskDeps {
  return { resolve: async () => project(), sessions: () => live("Jobs Matthias"), io, ...over };
}

// ── outcomes ────────────────────────────────────────────────────────────────

test("no live session -> absent, and nothing is spawned", async () => {
  const f = fake([screen("idle")]);
  const r = await ask("jobs-matthias", "status?", {}, deps(f.io, { sessions: () => [] }));
  assert.equal(r.state, "absent");
  assert.equal(r.replied, false);
  assert.equal(r.session, "");
  assert.equal(r.reason, "session not running");
  assert.equal(f.sent().length, 0, "must not send into a session that is not there");
});

test("no curated alias -> absent with a fix hint", async () => {
  const f = fake([screen("idle")]);
  const r = await ask("mystery", "status?", {}, deps(f.io, { resolve: async () => undefined }));
  assert.equal(r.state, "absent");
  assert.match(r.reason!, /pai project name/);
});

test("a busy session is reported ALIVE without being interrupted", async () => {
  // The case that makes a three-outcome contract unsafe: mid-turn work is
  // indistinguishable from wedged unless checked before asking.
  const f = fake([screen("working… 1"), screen("working… 2"), screen("working… 3")]);
  const r = await ask("jobs-matthias", "status?", {}, deps(f.io));
  assert.equal(r.state, "busy");
  assert.equal(r.replied, false);
  assert.equal(r.session, "Jobs Matthias");
  assert.equal(f.sent().length, 0, "a working session must not be charged tokens for a probe");
  assert.match(r.reason!, /evidence of life/);
});

test("an idle session is asked, and its answer is returned", async () => {
  const f = fake([screen("nothing new")], (q) => [
    screen(`❯ ${q}`),
    screen(`❯ ${q}\n\n⏺ still sweeping, ~10 min left`),
    screen(`❯ ${q}\n\n⏺ still sweeping, ~10 min left`),
    screen(`❯ ${q}\n\n⏺ still sweeping, ~10 min left`),
    screen(`❯ ${q}\n\n⏺ still sweeping, ~10 min left`),
    screen(`❯ ${q}\n\n⏺ still sweeping, ~10 min left`),
  ]);
  const r = await ask("jobs-matthias", "status?", {}, deps(f.io));
  assert.equal(r.state, "replied");
  assert.equal(r.replied, true);
  assert.equal(r.reply, "still sweeping, ~10 min left");
  assert.equal(f.sent().length, 1);
});

test("an idle session that never answers -> silent", async () => {
  const f = fake([screen("x")], (q) => [screen(`❯ ${q}`)]);
  const r = await ask("jobs-matthias", "status?", { timeoutMs: 8_000 }, deps(f.io));
  assert.equal(r.state, "silent");
  assert.equal(r.replied, false);
});

test("a session that never accepts the question -> silent, not replied", async () => {
  // Question sits unsubmitted in the input box forever.
  const f = fake([screen("x")], (q) => [`${RULE} Jobs Matthias ──\n❯ ${q}\n${RULE}`]);
  const r = await ask("jobs-matthias", "status?", { timeoutMs: 20_000 }, deps(f.io));
  assert.equal(r.state, "silent");
  assert.match(r.reason!, /never accepted/);
});

test("a session sitting at a shell prompt -> silent, and is not asked", async () => {
  const shell = "i052341 in ~/jobs\nFri 31 | 22:43:49 ➜ ";
  const f = fake([shell, shell, shell]);
  const r = await ask("jobs-matthias", "status?", {}, deps(f.io));
  assert.equal(r.state, "silent");
  assert.match(r.reason!, /not showing a Claude prompt/);
  assert.equal(f.sent().length, 0);
});

// ── the echo trap ───────────────────────────────────────────────────────────

test("the question echoed back is NOT mistaken for a reply", () => {
  const q = "are you still working on the sweep?";
  const frame = screen(`❯ ${q}`);
  assert.equal(extractReply(frame, q), "", "an echo with no answer must extract as empty");
});

test("a reply below the echo is extracted, the echo is not", () => {
  const q = "are you still working on the sweep?";
  const frame = screen(`❯ ${q}\n\n⏺ Yes — 40 of 72 mails archived.`);
  assert.equal(extractReply(frame, q), "Yes — 40 of 72 mails archived.");
});

test("a wrapped multi-line echo is skipped entirely", () => {
  // Long questions wrap; every continuation line must be skipped or the tail of
  // the question is returned as the answer.
  const q = "are you still working on the sweep, and roughly how much longer do you expect it to take?";
  const frame = screen(
    "❯ are you still working on the sweep, and roughly how much\n" +
    "  longer do you expect it to take?\n\n" +
    "⏺ About ten minutes.",
  );
  assert.equal(extractReply(frame, q), "About ten minutes.");
});

test("spinner and status lines are stripped from the reply", () => {
  const q = "status?";
  const frame = screen(`❯ ${q}\n\n⏺ Sweep is done.\n\n✻ Cogitated for 49s`);
  const reply = extractReply(frame, q);
  assert.match(reply, /Sweep is done/);
  assert.doesNotMatch(reply, /Cogitated/, "elapsed-time lines are not part of the answer");
});

test("tool-result chrome is not returned as the reply", () => {
  // Observed live: "⎿  1 skill available" was rendered above the answer and
  // came back as the first line of it.
  const q = "status?";
  const frame = screen(`❯ ${q}\n⎿  1 skill available\n\n⏺ Idle — repo clean.`);
  assert.equal(extractReply(frame, q), "Idle — repo clean.");
});

test("a multi-line reply keeps its lines", () => {
  const q = "status?";
  const frame = screen(`❯ ${q}\n\n⏺ Two things:\n  - archived 40 mails\n  - 32 to go`);
  const reply = extractReply(frame, q);
  assert.match(reply, /Two things/);
  assert.match(reply, /32 to go/);
});
