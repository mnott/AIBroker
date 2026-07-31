/**
 * test/sessions-manifest.test.ts — restore-manifest merge semantics.
 *
 * Regression cover for a real data loss: the manifest used to be rewritten with
 * exactly the sessions open at snapshot time. Shutting down drains that set to
 * zero, so the 5-minute snapshot agent persisted `[]` over a good restore list
 * while the user was /exit-ing tabs by hand.
 *
 * The invariant these tests defend: merging NEVER shrinks the manifest.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeEntries } from "../src/daemon/sessions.js";

const T0 = "2026-07-01T00:00:00.000Z";
const T1 = "2026-07-31T12:00:00.000Z";

const entry = (name: string, cwd: string, lastSeen = T0) => ({ name, cwd, lastSeen, addedAt: T0 });

test("empty live set leaves the manifest untouched", () => {
  const existing = [entry("PAI", "/p/pai"), entry("SL", "/p/sl")];
  const merged = mergeEntries(existing, [], T1);
  assert.deepEqual(merged, existing, "a shutdown must not erase the restore list");
});

test("a shrinking live set never drops records", () => {
  // Exactly the failure: tabs closing one at a time across successive snapshots.
  const full = [entry("PAI", "/p/pai"), entry("SL", "/p/sl"), entry("Devon", "/p/devon")];
  let m = mergeEntries(full, [entry("PAI", "/p/pai"), entry("SL", "/p/sl")], T1);
  m = mergeEntries(m, [entry("PAI", "/p/pai")], T1);
  m = mergeEntries(m, [], T1);
  assert.equal(m.length, 3);
  assert.deepEqual(m.map((e) => e.name).sort(), ["Devon", "PAI", "SL"]);
});

test("sessions sharing a directory are kept apart", () => {
  // "Home" and "Solar" both run in $HOME; keying on cwd alone collapsed them
  // and restore silently reopened only one.
  const merged = mergeEntries([], [entry("Home", "/Users/x"), entry("Solar", "/Users/x")], T1);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged.map((e) => e.name).sort(), ["Home", "Solar"]);
});

test("re-seeing a session refreshes lastSeen but does not duplicate it", () => {
  const merged = mergeEntries([entry("PAI", "/p/pai")], [entry("PAI", "/p/pai", T1)], T1);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].lastSeen, T1);
  assert.equal(merged[0].addedAt, T0, "addedAt is the first sighting and must survive");
});

test("a newly opened session is added", () => {
  const merged = mergeEntries([entry("PAI", "/p/pai")], [entry("Glidr", "/p/glidr")], T1);
  assert.equal(merged.length, 2);
  assert.ok(merged.some((e) => e.name === "Glidr"));
});

test("duplicate live rows for one session collapse to a single record", () => {
  const merged = mergeEntries([], [entry("PAI", "/p/pai"), entry("PAI", "/p/pai")], T1);
  assert.equal(merged.length, 1);
});

test("merging is never lossy for any input", () => {
  // Property check over the shapes a real snapshot produces.
  const names = ["PAI", "SL", "Home", "Solar", "Devon"];
  const dirs = ["/Users/x", "/p/a", "/p/b"];
  const all = names.flatMap((n) => dirs.map((d) => entry(n, d)));
  for (let i = 0; i < all.length; i++) {
    const existing = all.slice(0, i);
    for (let j = 0; j < all.length; j++) {
      const merged = mergeEntries(existing, all.slice(j), T1);
      assert.ok(merged.length >= existing.length, `shrank: existing=${i} fresh-from=${j}`);
      for (const e of existing) {
        assert.ok(
          merged.some((m) => m.name === e.name && m.cwd === e.cwd),
          `lost ${e.name} ${e.cwd}`,
        );
      }
    }
  }
});
