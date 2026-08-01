/**
 * test/send-to-session-ack.test.ts — ok:true must not mean "typed".
 *
 * The bug this pins: send_to_session reported success from typeIntoSession(),
 * which says only that the WRITE happened. A message typed into a busy session
 * sits unsubmitted in its input box, and the sender was told "delivered". PAI
 * lost a request that way on 2026-07-31 — it sat unread for nearly two hours
 * while the sender had seen ok:true.
 *
 * The confirmation itself is submitAndConfirm(), already covered in
 * dispatch.test.ts. What matters here is the promise the caller is given:
 * delivered and queued are different, and both must be sayable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { submitAndConfirm, flatten } from "../src/daemon/dispatch.js";
import type { TerminalIO } from "../src/daemon/dispatch.js";

/** A session that accepts input: the text leaves the ❯ line on the next poll. */
function acceptingIO(): TerminalIO {
  let t = 0;
  let polls = 0;
  let sent = "";
  return {
    // First capture still shows it on the input line; by the next poll it has
    // been submitted and appears above the prompt. That transition — present
    // in the frame but no longer on ❯ — is the only reliable submit signal.
    capture: () => (polls > 0 ? `${sent}\n❯ ` : `❯ ${sent}`),
    send: (_id: string, body: string) => { sent = flatten(body); polls = 0; return true; },
    sleep: async () => { t += 500; polls++; },
    now: () => t,
  } as unknown as TerminalIO;
}

/** A session mid-task: the text is typed and never leaves the input line. */
function busyIO(): TerminalIO {
  let t = 0;
  let sent = "";
  return {
    capture: () => `❯ ${sent}`,
    send: (_id: string, body: string) => { sent = flatten(body).slice(0, 48); return true; },
    sleep: async () => { t += 500; },
    now: () => t,
  } as unknown as TerminalIO;
}

/** A session whose terminal cannot be read at all. */
function unreadableIO(): TerminalIO {
  let t = 0;
  return {
    capture: () => null,
    send: () => true,
    sleep: async () => { t += 500; },
    now: () => t,
  } as unknown as TerminalIO;
}

test("a session that takes the message acknowledges it", async () => {
  const r = await submitAndConfirm("s", "[Session:PAI] run the sweep", 3000, acceptingIO());
  assert.equal(r, "ok");
});

test("a busy session does NOT acknowledge — this is the silent drop", async () => {
  // The old code returned success here, because the write itself succeeded.
  const r = await submitAndConfirm("s", "[Session:PAI] run the sweep", 2000, busyIO());
  assert.equal(r, "no-ack");
});

test("an unreadable terminal is distinguished from a refusal", async () => {
  // "I could not check" and "they did not take it" send whoever reads the
  // result looking in different places.
  const r = await submitAndConfirm("s", "[Session:PAI] run the sweep", 2000, unreadableIO());
  assert.equal(r, "unreadable");
});

test("the wait is bounded by the caller's budget", async () => {
  // A handler someone is waiting on must not outlive its own timeout: an
  // unconfirmed message is queued in the mailbox, not lost, so returning
  // "queued" quickly beats blocking to say "delivered".
  const io = busyIO();
  await submitAndConfirm("s", "[Session:PAI] x", 1500, io);
  assert.ok(io.now() <= 2000, `stopped at ${io.now()}ms, budget was 1500ms`);
});

// ── retrying is not the same as resending ───────────────────────────────────

test("an unconfirmed send types the message ONCE, never again", async () => {
  // The first version of the delivery fix used submitAndConfirm's default of
  // three attempts. Dispatch can afford that: it may be talking to a session
  // that was not ready, where an earlier attempt never landed. A live session
  // already has the text in its input box, so a second attempt is a second
  // copy — and PAI received one message three times, byte-identical. The exact
  // mirror of the bug being fixed: one delivery reported as three, instead of
  // three reported as one.
  let sends = 0;
  let t = 0;
  const io = {
    capture: () => "❯ typed but never submitted",
    send: () => { sends++; return true; },
    sleep: async () => { t += 500; },
    now: () => t,
  } as unknown as TerminalIO;

  const r = await submitAndConfirm("s", "[Session:PAI] hello", 3000, io, 1);
  assert.equal(r, "no-ack");
  assert.equal(sends, 1, `typed ${sends} times; a live session must be written to once`);
});

test("dispatch keeps its retries — the two callers want different things", async () => {
  let sends = 0;
  let t = 0;
  const io = {
    capture: () => "❯ typed but never submitted",
    send: () => { sends++; return true; },
    sleep: async () => { t += 500; },
    now: () => t,
  } as unknown as TerminalIO;

  await submitAndConfirm("s", "x", 6000, io, 3);
  assert.ok(sends > 1, "a spawning dispatch may legitimately try again");
});
