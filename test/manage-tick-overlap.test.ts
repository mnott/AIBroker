import "./home-guard.js";
/**
 * test/manage-tick-overlap.test.ts — overlapping manager ticks must not arm a
 * session twice (observed 2026-10-10: two arms 0.9 s apart under load).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { nonOverlapping, tryExclusive } from "../src/daemon/manage.js";

const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
};

test("a tick with a slow reader does not start a second concurrent tick", async () => {
  const g = gate();
  let started = 0;
  let skipped = 0;
  const guarded = nonOverlapping(async () => { started++; await g.p; }, () => { skipped++; });
  const first = guarded();
  await guarded();
  await guarded();
  assert.equal(started, 1);
  assert.equal(skipped, 2);
  g.open();
  await first;
  await guarded();
  assert.equal(started, 2, "next tick runs once the first finished");
});

test("a failing tick releases the guard", async () => {
  let started = 0;
  const guarded = nonOverlapping(async () => { started++; throw new Error("boom"); }, () => {});
  await assert.rejects(guarded());
  await assert.rejects(guarded());
  assert.equal(started, 2);
});

test("concurrent now-style and tick arms of one session arm once", async () => {
  const g = gate();
  const busy = new Set<string>();
  let arms = 0;
  const arm = async () => { arms++; await g.p; return true; };
  const a = tryExclusive(busy, "s1", arm);
  const b = tryExclusive(busy, "s1", arm);
  const other = tryExclusive(busy, "s2", arm);
  assert.equal(await b, undefined);
  g.open();
  assert.equal(await a, true);
  assert.equal(await other, true);
  assert.equal(arms, 2, "s1 once, s2 once");
  assert.equal(busy.size, 0);
});
