import "./home-guard.js";
/**
 * test/manage-readback-poll.test.ts — arm()'s read-back waits for the paste to
 * render instead of reading once after a fixed 300 ms (under heavy load the
 * input was still empty and every arming aborted).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readBackTyped, typedLineMatches } from "../src/daemon/manage.js";

const GOAL = "/goal Follow ~/.aibroker/manage-briefs/x.md until done";

function run(lines: string[]) {
  let reads = 0;
  const slept: number[] = [];
  return readBackTyped({
    read: async () => lines[Math.min(reads++, lines.length - 1)],
    sleep: async (ms) => void slept.push(ms),
  }).then((r) => ({ ...r, reads, slept }));
}

test("empty, empty, then the goal: matches without abort", async () => {
  const r = await run(["", "", GOAL]);
  assert.equal(r.reads, 3);
  assert.ok(typedLineMatches(r.line, GOAL));
});

test("always empty: gives up after the bound (~5 s)", async () => {
  const r = await run([""]);
  assert.equal(r.line, "");
  assert.equal(r.reads, 7);
  assert.ok(r.waitedMs >= 4_500 && r.waitedMs <= 6_000, String(r.waitedMs));
});

test("mangled: returned immediately once non-empty", async () => {
  const r = await run(["", "garbage"]);
  assert.equal(r.reads, 2);
  assert.equal(r.line, "garbage");
  assert.ok(!typedLineMatches(r.line, GOAL));
});
