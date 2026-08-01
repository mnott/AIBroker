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
  recordClaim, forgetClaim, listClaims, expiredClaims, sweepAbandonedClaims, CLAIM_MAX_AGE_MS,
} = await import("../src/daemon/todoist-claims.js");

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

/** Each sweep test owns the whole store: a leftover claim from another test
 *  would be swept too, and the assertion would be about the wrong task. */
function clear(): void {
  for (const c of listClaims()) forgetClaim(c.taskId);
}

test("a fresh claim is not expired", () => {
  recordClaim("t-fresh");
  assert.equal(expiredClaims().some((c) => c.taskId === "t-fresh"), false);
});

test("a claim older than the window is expired", () => {
  recordClaim("t-old", ago(CLAIM_MAX_AGE_MS + 60_000));
  assert.equal(expiredClaims().some((c) => c.taskId === "t-old"), true);
});

test("the window is longer than PAI's, so the better-informed release wins", () => {
  // PAI ages its own claims at max(expected x 10, 120 min) and knows what the
  // task usually costs. This is only ever the backstop for a machine running
  // the webhook trigger with no poller at all.
  assert.ok(CLAIM_MAX_AGE_MS > 120 * 60 * 1000);
});

test("sweeping releases the label and forgets the claim", async () => {
  clear();
  recordClaim("t-sweep", ago(CLAIM_MAX_AGE_MS + 1000));
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
  recordClaim("t-fail", ago(CLAIM_MAX_AGE_MS + 1000));
  const done = await sweepAbandonedClaims(async () => { throw new Error("api down"); });
  assert.deepEqual(done, []);
  assert.equal(listClaims().some((c) => c.taskId === "t-fail"), true);
});

test("releasing is idempotent, so two releasers converge", async () => {
  clear();
  // PAI may release the same claim. Removing an absent label is a no-op, which
  // is why two releasers are safe where two dispatchers would not be.
  recordClaim("t-twice", ago(CLAIM_MAX_AGE_MS + 1000));
  await sweepAbandonedClaims(async () => {});
  const second = await sweepAbandonedClaims(async () => {});
  assert.deepEqual(second, []);
});

test("a completed dispatch forgets its claim without waiting for the sweep", () => {
  recordClaim("t-done");
  forgetClaim("t-done");
  assert.equal(listClaims().some((c) => c.taskId === "t-done"), false);
});
