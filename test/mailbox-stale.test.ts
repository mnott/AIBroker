/**
 * test/mailbox-stale.test.ts — "queued" is an instant, not a duration.
 *
 * send_to_session reports "queued" when it cannot confirm the target took a
 * message. That is honest when it is said. It stops being honest with time: a
 * message queued at 14:00 and still undrained at 18:00 is undelivered, and an
 * audit that still calls it "queued" is a silent failure wearing a truthful
 * label — harder to spot than an obvious lie, because nothing looks wrong.
 *
 * The same shape as PAI's deferred scheduler tick and our own unlaunchable
 * dispatch: fine as a moment, a fault as a duration.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The sweep writes audit records, and audit resolves ~/.aibroker at import
// time. Without this the suite appends test rows to the real trail — which it
// did, and two "run the sweep" entries are sitting in the production audit as
// a result. A test that leaves evidence in the thing it is testing corrupts
// the record everyone else is trusting.
const scratch = mkdtempSync(join(tmpdir(), "aibroker-stale-"));
process.env.HOME = scratch;
mkdirSync(join(scratch, ".aibroker"), { recursive: true });

const { depositToSessionMailbox, drainSessionMailbox, listSessionMailboxes } = await import("../src/core/state.js");
const { sweepStaleMailboxes, STALE_AFTER_MS } = await import("../src/daemon/mailbox-watch.js");

function clear(): void {
  for (const { sessionId } of listSessionMailboxes()) drainSessionMailbox(sessionId);
}

test("a fresh message is not stale", () => {
  clear();
  depositToSessionMailbox("s-1", "PAI", "run the sweep");
  assert.equal(sweepStaleMailboxes(Date.now()).length, 0);
});

test("a message nobody drained becomes its own outcome", () => {
  clear();
  depositToSessionMailbox("s-1", "PAI", "run the sweep");
  const later = Date.now() + STALE_AFTER_MS + 1000;
  const stale = sweepStaleMailboxes(later);
  assert.equal(stale.length, 1);
  assert.equal(stale[0].content, "run the sweep");
});

test("a stale message is reported once, not on every sweep", () => {
  // Otherwise the signal drowns in its own repetition and gets filtered out,
  // which is how a real fault becomes background noise.
  clear();
  depositToSessionMailbox("s-1", "PAI", "run the sweep");
  const later = Date.now() + STALE_AFTER_MS + 1000;
  assert.equal(sweepStaleMailboxes(later).length, 1);
  assert.equal(sweepStaleMailboxes(later + 60_000).length, 0);
});

test("draining before the deadline means nothing is reported", () => {
  clear();
  depositToSessionMailbox("s-1", "PAI", "run the sweep");
  assert.equal(drainSessionMailbox("s-1").length, 1);
  assert.equal(sweepStaleMailboxes(Date.now() + STALE_AFTER_MS + 1000).length, 0);
});

test("an overflowing mailbox hands back what it dropped", () => {
  // The eviction used to be a bare shift(): a message discarded with no trace,
  // which is the very loss the mailbox exists to prevent.
  clear();
  let evicted;
  for (let i = 0; i < 101; i++) {
    const d = depositToSessionMailbox("s-2", "PAI", `msg-${i}`);
    if (d) evicted = d;
  }
  assert.ok(evicted, "the 101st deposit must report the eviction");
  assert.equal(evicted!.content, "msg-0", "oldest goes first");
});
