/**
 * test/sessions-checkpoint.test.ts — verified checkpoint delivery.
 *
 * `checkpoint` used to fire AppleScript `write text` and assume it worked, which
 * is why one Claude hiccup meant hand-visiting every tab. sendVerified() instead
 * watches the terminal and reports per-session success. These tests drive it
 * against a scripted fake terminal — no iTerm, no real sessions, no sleeping.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  sendVerified,
  SETTLE_TICKS,
  type SessionProbe,
} from "../src/daemon/sessions.js";

/**
 * A fake terminal driven by a frame script. Each poll advances one frame; the
 * last frame repeats forever (a settled screen). `onSend` rewrites the script to
 * model what the session does when it receives the message.
 */
function fakeTerminal(initial: string, onSend: (attempt: number) => string[]) {
  let frames: string[] = [];
  let i = 0;
  let clock = 0;
  let attempt = 0;
  const sends: string[] = [];

  const probe: SessionProbe = {
    capture: () => (frames.length === 0 ? initial : frames[Math.min(i, frames.length - 1)]),
    send: (_id, text) => {
      sends.push(text);
      frames = onSend(++attempt);
      i = 0;
    },
    sleep: async () => { clock += 500; i++; },
    now: () => clock,
  };
  return { probe, sends: () => sends, attempts: () => attempt };
}

const OPTS = { timeoutMs: 120_000, retries: 3 };

/** A frozen screen: what an unsubmitted prompt looks like. */
const frozen = (s: string) => [s];

test("a session that responds and finishes reports ok", () => {
  return (async () => {
    const t = fakeTerminal("idle", () => [
      "> pause session",       // prompt echoed
      "thinking…",             // spinner: second distinct frame -> ack
      "writing checkpoint",
      "done",                  // repeats from here -> settles
    ]);
    assert.equal(await sendVerified("s1", "pause session", OPTS, t.probe), "ok");
    assert.equal(t.attempts(), 1, "no retry needed");
  })();
});

test("a swallowed Enter is caught, not reported as success", async () => {
  // The exact false positive a one-change ack would produce: the text appears in
  // the input box (one frame changes) and then nothing ever happens.
  const t = fakeTerminal("idle", () => frozen("> pause session"));
  assert.equal(await sendVerified("s1", "pause session", OPTS, t.probe), "no-ack");
  assert.equal(t.attempts(), 3, "should exhaust its retries trying to get through");
});

test("a totally unresponsive session reports no-ack after retrying", async () => {
  const t = fakeTerminal("idle", () => frozen("idle"));
  assert.equal(await sendVerified("s1", "pause session", OPTS, t.probe), "no-ack");
  assert.equal(t.attempts(), 3);
});

test("a retry that finally lands succeeds", async () => {
  const t = fakeTerminal("idle", (attempt) =>
    attempt < 3 ? frozen("> pause session") : ["> pause session", "thinking…", "done"],
  );
  assert.equal(await sendVerified("s1", "pause session", OPTS, t.probe), "ok");
  assert.equal(t.attempts(), 3);
});

test("a session still working when time runs out reports no-settle", async () => {
  let n = 0;
  const probe: SessionProbe = {
    capture: () => `frame ${n}`, // never repeats -> never settles
    send: () => {},
    sleep: async () => { n++; },
    now: () => n * 500,
  };
  assert.equal(await sendVerified("s1", "pause session", { timeoutMs: 5_000, retries: 3 }, probe), "no-settle");
});

test("an unreadable session is reported, not silently skipped", async () => {
  const probe: SessionProbe = {
    capture: () => null,
    send: () => { throw new Error("must not send to an unreadable session"); },
    sleep: async () => {},
    now: () => 0,
  };
  assert.equal(await sendVerified("s1", "pause session", OPTS, probe), "unreadable");
});

test("settling requires a genuinely quiet screen, not one still frame", async () => {
  // Streaming output that pauses briefly must NOT be mistaken for completion.
  const blip = ["> p", "a", "b", "b", "b", "c", "d", "d", "d", "d", "d", "d"];
  const t = fakeTerminal("idle", () => blip);
  assert.equal(await sendVerified("s1", "pause session", OPTS, t.probe), "ok");
  assert.ok(SETTLE_TICKS >= 3, "a single repeated frame must not count as settled");
});

test("the message is sent verbatim", async () => {
  const t = fakeTerminal("idle", () => ["a", "b", "c", "c"]);
  await sendVerified("s1", "pause session", OPTS, t.probe);
  assert.deepEqual(t.sends(), ["pause session"]);
});
