/**
 * The drain-mailbox hook marks messages shown instead of deleting them, so a
 * body that never reached the model (mid-turn pointer, 2026-10-10) is still
 * returned by aibroker_receive.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "aibroker-shown-"));
process.env.HOME = scratch;
mkdirSync(join(scratch, ".aibroker"), { recursive: true });

const { depositToSessionMailbox, drainSessionMailbox, peekSessionMailbox, markMailboxShown, listSessionMailboxes } =
  await import("../src/core/state.js");

const live = (id: string) => listSessionMailboxes().find((m) => m.sessionId === id)!.messages;

test("hook drain then receive returns the body once, marked shown", () => {
  depositToSessionMailbox("a", "PAI", "body");
  const peeked = peekSessionMailbox("a");
  assert.equal(peeked.length, 1);
  assert.equal(markMailboxShown("a", peeked.length), 1);
  const got = drainSessionMailbox("a");
  assert.equal(got.length, 1);
  assert.equal(got[0].content, "body");
  assert.ok(got[0].shownAt);
  assert.equal(drainSessionMailbox("a").length, 0);
});

test("hook drain twice shows the message once", () => {
  depositToSessionMailbox("b", "PAI", "one");
  markMailboxShown("b", peekSessionMailbox("b").length);
  assert.equal(peekSessionMailbox("b").length, 0);
  depositToSessionMailbox("b", "PAI", "two");
  assert.deepEqual(peekSessionMailbox("b").map((m) => m.content), ["two"]);
  drainSessionMailbox("b");
});

test("shown messages are pruned after 30 min; unshown are kept", () => {
  depositToSessionMailbox("c", "PAI", "old");
  depositToSessionMailbox("c", "PAI", "fresh");
  markMailboxShown("c", 1, Date.now() - 31 * 60_000);
  const got = drainSessionMailbox("c");
  assert.deepEqual(got.map((m) => m.content), ["fresh"]);
});

test("shown within 30 min survives a peek", () => {
  depositToSessionMailbox("c2", "PAI", "x");
  markMailboxShown("c2", 1, Date.now() - 10 * 60_000);
  peekSessionMailbox("c2");
  assert.equal(drainSessionMailbox("c2").length, 1);
});

test("eviction at the cap drops a shown message before an unshown one", () => {
  for (let i = 0; i < 100; i++) depositToSessionMailbox("d", "PAI", `m${i}`);
  markMailboxShown("d", 1); // oldest...
  live("d")[0].shownAt = undefined;
  live("d")[5].shownAt = Date.now(); // ...but m5 is the shown one
  const dropped = depositToSessionMailbox("d", "PAI", "new");
  assert.equal(dropped?.content, "m5");
  assert.equal(live("d").length, 100);
  // none shown left: oldest goes
  live("d").forEach((m) => { m.shownAt = undefined; });
  assert.equal(depositToSessionMailbox("d", "PAI", "newer")?.content, "m0");
  drainSessionMailbox("d");
});

test("old-format entries (no shownAt) behave as unshown", () => {
  depositToSessionMailbox("e", "PAI", "legacy");
  delete (live("e")[0] as { shownAt?: number }).shownAt;
  assert.equal(peekSessionMailbox("e").length, 1);
  assert.equal(drainSessionMailbox("e").length, 1);
});
