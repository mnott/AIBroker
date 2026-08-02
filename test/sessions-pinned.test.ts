/**
 * test/sessions-pinned.test.ts — a deliberate directory must survive a sighting.
 *
 * The manifest keys on name+cwd, which is right for merging: two sessions at
 * different paths are different entries. It is wrong for a session that has
 * been REPOINTED. Solar was started in the home directory and later given its
 * real project; the next snapshot, seeing the live process still in `~`, would
 * not match the corrected entry and would add a SECOND Solar. The correction
 * would undo itself within five minutes, and nothing would report that it had —
 * the same shape as a registry scan reverting a repair.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeEntries } from "../src/daemon/sessions.js";

const T1 = "2026-08-01T10:00:00.000Z";
const T2 = "2026-08-02T10:00:00.000Z";
const seen = (name: string, cwd: string) => ({ name, cwd });

test("a pinned entry keeps its cwd when the live session is elsewhere", () => {
  const pinned = { name: "Solar", cwd: "/projects/fotovoltaik", pinned: true, addedAt: T1 };
  const merged = mergeEntries([pinned], [seen("Solar", "/Users/x")], T2);
  assert.equal(merged.length, 1, "no duplicate — matched by name, not by path");
  assert.equal(merged[0].cwd, "/projects/fotovoltaik");
  assert.equal(merged[0].lastSeen, T2, "still recorded as seen");
});

test("a pinned entry that is not open right now is left completely alone", () => {
  const pinned = { name: "Solar", cwd: "/projects/fotovoltaik", pinned: true, lastSeen: T1 };
  assert.deepEqual(mergeEntries([pinned], [], T2), [pinned]);
});

test("an unpinned entry still merges by path, exactly as before", () => {
  // The pin is opt-in. Nothing else changes behaviour.
  const merged = mergeEntries([{ name: "Home", cwd: "/Users/x", lastSeen: T1 }], [seen("Home", "/Users/x")], T2);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].lastSeen, T2);
});

test("an unpinned entry seen at a NEW path still gains a second entry", () => {
  // That is the existing contract and the reason pinning had to be opt-in:
  // the same name at a genuinely different path is a different session.
  const merged = mergeEntries([{ name: "Home", cwd: "/Users/x" }], [seen("Home", "/elsewhere")], T2);
  assert.equal(merged.length, 2);
});

test("a pinned entry does not swallow an unrelated session's sighting", () => {
  const pinned = { name: "Solar", cwd: "/projects/fotovoltaik", pinned: true };
  const merged = mergeEntries([pinned], [seen("Home", "/Users/x")], T2);
  assert.equal(merged.length, 2, "Home is unrelated and must still be added");
});

test("a pinned entry absorbs a sighting at any path, not just the pinned one", () => {
  // The whole point: the live directory is expected to disagree.
  const pinned = { name: "Solar", cwd: "/projects/fotovoltaik", pinned: true };
  for (const live of ["/Users/x", "/tmp", "/projects/fotovoltaik"]) {
    const merged = mergeEntries([pinned], [seen("Solar", live)], T2);
    assert.equal(merged.length, 1, `live at ${live} must not create a duplicate`);
  }
});
