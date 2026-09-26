import "./home-guard.js";
/**
 * test/drain-mailbox-worker-guard.test.ts — a worker must never drain the
 * pane owner's mailbox.
 *
 * hooks/drain-mailbox.mjs is a UserPromptSubmit hook: it reads
 * TMUX_PANE/ITERM_SESSION_ID from the environment and drains that session's
 * mailbox. A worker child process (`pai worker run`, PAI_WORKER=1) inherits
 * those same env vars from the pane it was spawned in, so without a guard it
 * would resolve to — and drain — the PANE OWNER's real mailbox on the
 * worker's own prompts. Observed live 2026-09-23: a worker's reply was
 * recorded as delivered but never surfaced in the real session, and
 * aibroker_receive there found nothing — the worker's own copy of this hook
 * had already drained it.
 *
 * Draining is destructive and talks to the real daemon socket, so this test
 * proves the guard WITHOUT depending on (or touching) it: with PAI_WORKER=1
 * the hook must exit before ever reaching the network call, which is fast
 * and deterministic regardless of whether a daemon is listening.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, "..", "hooks", "drain-mailbox.mjs");

test("PAI_WORKER=1: exits immediately with no output, even with a claimable session id", () => {
  const start = Date.now();
  const r = spawnSync("node", [HOOK], {
    env: { ...process.env, PAI_WORKER: "1", ITERM_SESSION_ID: "w0t0p0:00000000-0000-0000-0000-000000000000" },
    input: "",
    encoding: "utf8",
    timeout: 5000,
  });
  const elapsed = Date.now() - start;
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "", "a worker must never emit a drained-mailbox reminder");
  // The guard is the first statement — no socket connect, no 1500ms budget.
  assert.ok(elapsed < 500, `guard should short-circuit near-instantly, took ${elapsed}ms`);
});

test("no session id at all: still exits immediately with no output (baseline, unchanged)", () => {
  const r = spawnSync("node", [HOOK], {
    env: { ...process.env, PAI_WORKER: "", ITERM_SESSION_ID: "", TMUX_PANE: "" },
    input: "",
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "");
});
