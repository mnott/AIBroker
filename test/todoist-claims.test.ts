/**
 * test/todoist-claims.test.ts — releasing a claim nobody came back for.
 *
 * The webhook claims a trigger before dispatching, so two mechanisms watching
 * one checkbox cannot both fire. Correct while the run is alive; a trap when it
 * is not. A session that dies mid-turn leaves the task claimed, the webhook
 * then skips it, and the routine is dead until a human notices it stopped —
 * permanent silence, which is worse than a duplicate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "aibroker-claims-"));
process.env.HOME = scratch;
mkdirSync(join(scratch, ".aibroker"), { recursive: true });

const {
  recordClaim, forgetClaim, listClaims, expiredClaims, sweepAbandonedClaims,
  claimDeadline, CLAIM_MIN_AGE_MS, CLAIM_FALLBACK_AGE_MS,
} = await import("../src/daemon/todoist-claims.js");

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

/** Each sweep test owns the whole store: a leftover claim from another test
 *  would be swept too, and the assertion would be about the wrong task. */
function clear(): void {
  for (const c of listClaims()) forgetClaim(c.taskId);
}

const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

test("a fresh claim is not expired", () => {
  clear();
  recordClaim("t-fresh", undefined, inHours(24));
  assert.equal(expiredClaims().some((c) => c.taskId === "t-fresh"), false);
});

test("the deadline is the next occurrence, not a fixed duration", () => {
  // A flat window cannot stay behind an adaptive one. PAI releases at
  // max(expected x 10, 120 min); a flat 180 min sat behind that only for tasks
  // expected under 18 minutes and IN FRONT of it for every real routine, so the
  // less informed release fired first.
  const daily = { claimedAt: new Date().toISOString(), nextDue: inHours(24) };
  const hours = (claimDeadline(daily) - Date.now()) / 3600_000;
  assert.ok(hours > 23 && hours < 24, `deadline at ${hours}h should sit just inside the next run`);
});

test("a claim never survives into the run it would block", () => {
  // Past the next occurrence the trigger arrives and the claim suppresses it,
  // which is the silence again.
  const c = { claimedAt: ago(20 * 3600_000), nextDue: inHours(0.01) };
  assert.ok(claimDeadline(c) < Date.parse(c.nextDue));
});

test("a slow run is not released in its first two hours", () => {
  // Even a frequent task: a run is allowed to overrun its own period once.
  const hourly = { claimedAt: new Date().toISOString(), nextDue: inHours(1) };
  assert.equal(claimDeadline(hourly), Date.parse(hourly.claimedAt) + CLAIM_MIN_AGE_MS);
});

test("with no known occurrence it falls back to twelve hours", () => {
  // Chosen to clear an adaptive poller's default rather than to be right.
  const c = { claimedAt: new Date().toISOString() };
  assert.equal(claimDeadline(c), Date.parse(c.claimedAt) + CLAIM_FALLBACK_AGE_MS);
  assert.ok(CLAIM_FALLBACK_AGE_MS > 5 * 3600_000, "must clear PAI's 30-minute default of 5h");
});

test("a four-hour run on a daily task is left alone", () => {
  // The concrete regression: a flat 3h window released this claim mid-run and
  // the next poll dispatched a second sweep alongside the first.
  clear();
  recordClaim("t-slow", ago(4 * 3600_000), inHours(20));
  assert.equal(expiredClaims().some((c) => c.taskId === "t-slow"), false);
});

test("a claim recorded in the old bare-timestamp shape still ages", () => {
  // 0.17.2 stored a string. An upgrade must not strand those forever.
  clear();
  recordClaim("t-legacy", ago(CLAIM_FALLBACK_AGE_MS + 3600_000));
  assert.equal(expiredClaims().some((c) => c.taskId === "t-legacy"), true);
});

test("sweeping releases the label and forgets the claim", async () => {
  clear();
  recordClaim("t-sweep", ago(CLAIM_FALLBACK_AGE_MS + 1000));
  const released: string[] = [];
  const done = await sweepAbandonedClaims(async (id) => { released.push(id); });
  assert.deepEqual(done, ["t-sweep"]);
  assert.deepEqual(released, ["t-sweep"]);
  assert.equal(listClaims().some((c) => c.taskId === "t-sweep"), false);
});

test("a failed release keeps the record, to be retried next sweep", async () => {
  clear();
  // Forgetting a claim we could not actually remove would leave the label on
  // the task forever with nothing tracking it — the exact silence being fixed.
  recordClaim("t-fail", ago(CLAIM_FALLBACK_AGE_MS + 1000));
  const done = await sweepAbandonedClaims(async () => { throw new Error("api down"); });
  assert.deepEqual(done, []);
  assert.equal(listClaims().some((c) => c.taskId === "t-fail"), true);
});

test("releasing is idempotent, so two releasers converge", async () => {
  clear();
  // PAI may release the same claim. Removing an absent label is a no-op, which
  // is why two releasers are safe where two dispatchers would not be.
  recordClaim("t-twice", ago(CLAIM_FALLBACK_AGE_MS + 1000));
  await sweepAbandonedClaims(async () => {});
  const second = await sweepAbandonedClaims(async () => {});
  assert.deepEqual(second, []);
});

test("a completed dispatch forgets its claim without waiting for the sweep", () => {
  recordClaim("t-done");
  forgetClaim("t-done");
  assert.equal(listClaims().some((c) => c.taskId === "t-done"), false);
});

// ── who takes the claim off ─────────────────────────────────────────────────
//
// The webhook sets pai-running at dispatch and only removes it on a failed
// dispatch or at the next occurrence. Nothing else here does. So a session that
// finishes its work and says nothing leaves the trigger suppressed until then —
// one silently missed run, looking exactly like a run nobody asked for. The
// finished run has to be able to release its own claim.

test("a finished run forgets its claim immediately", () => {
  clear();
  recordClaim("t-finished", undefined, inHours(24));
  assert.equal(listClaims().some((c) => c.taskId === "t-finished"), true);
  forgetClaim("t-finished");
  assert.equal(listClaims().some((c) => c.taskId === "t-finished"), false);
});

test("a claim released early is not resurrected by the sweep", () => {
  clear();
  recordClaim("t-early", ago(48 * 3600_000), inHours(-1));
  forgetClaim("t-early");
  assert.deepEqual(expiredClaims().filter((c) => c.taskId === "t-early"), []);
});
