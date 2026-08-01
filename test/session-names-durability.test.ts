/**
 * test/session-names-durability.test.ts
 *
 * session-names.json maps every session id to its PAI name, and those names are
 * what dispatch and name-targeted sends resolve against. Losing it does not
 * merely lose labels — it makes projects unroutable and makes dispatch judge
 * every session dead.
 *
 * Driven through the public API rather than the store, because the bug was in
 * how the API composed with it: `?? {}` on read, plus a cache, plus an
 * unconditional save.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  setAppDir,
  setPersistentSessionName,
  getPersistentSessionName,
  getAllPersistentSessionNames,
} from "../src/core/persistence.js";

const NAMES = "session-names.json";

/** A realistic store: many sessions, as on a working machine. */
function manyNames(n: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < n; i++) out[`id-${i}`] = `Project ${i}`;
  return out;
}

test("renaming one session preserves every other name", () => {
  const dir = mkdtempSync(join(tmpdir(), "aibroker-names-"));
  writeFileSync(join(dir, NAMES), JSON.stringify(manyNames(80)));
  setAppDir(dir);

  setPersistentSessionName("id-new", "Freshly Named");

  const onDisk = JSON.parse(readFileSync(join(dir, NAMES), "utf-8"));
  assert.equal(Object.keys(onDisk).length, 81);
  assert.equal(onDisk["id-0"], "Project 0");
  assert.equal(onDisk["id-79"], "Project 79");
  assert.equal(onDisk["id-new"], "Freshly Named");

  rmSync(dir, { recursive: true, force: true });
});

test("a corrupt name file is never replaced by a single rename", () => {
  // The failure: 80 names read as {}, one rename saved, 80 names gone. Silently.
  const dir = mkdtempSync(join(tmpdir(), "aibroker-names-"));
  const path = join(dir, NAMES);
  const corrupt = '{"id-0":"Project 0","id-1": TRUNCATED';
  writeFileSync(path, corrupt);
  setAppDir(dir);

  setPersistentSessionName("id-new", "Freshly Named");

  assert.equal(
    readFileSync(path, "utf-8"),
    corrupt,
    "the only copy of those names is this file — it must survive",
  );

  rmSync(dir, { recursive: true, force: true });
});

test("names still resolve in-memory while the file is unreadable", () => {
  // Degrade, don't collapse: the daemon keeps running, it just cannot persist.
  const dir = mkdtempSync(join(tmpdir(), "aibroker-names-"));
  writeFileSync(join(dir, NAMES), "NOT JSON");
  setAppDir(dir);

  setPersistentSessionName("id-a", "Alpha");
  assert.equal(getPersistentSessionName("id-a"), "Alpha");
  assert.deepEqual(getAllPersistentSessionNames(), { "id-a": "Alpha" });

  rmSync(dir, { recursive: true, force: true });
});

test("a fresh install writes names normally", () => {
  const dir = mkdtempSync(join(tmpdir(), "aibroker-names-"));
  setAppDir(dir);

  setPersistentSessionName("id-a", "Alpha");
  const onDisk = JSON.parse(readFileSync(join(dir, NAMES), "utf-8"));
  assert.deepEqual(onDisk, { "id-a": "Alpha" });

  rmSync(dir, { recursive: true, force: true });
});

test("switching app dir does not write names into the old location", () => {
  const a = mkdtempSync(join(tmpdir(), "aibroker-names-a-"));
  const b = mkdtempSync(join(tmpdir(), "aibroker-names-b-"));

  setAppDir(a);
  setPersistentSessionName("id-a", "InA");

  setAppDir(b);
  setPersistentSessionName("id-b", "InB");

  assert.deepEqual(JSON.parse(readFileSync(join(a, NAMES), "utf-8")), { "id-a": "InA" });
  assert.deepEqual(JSON.parse(readFileSync(join(b, NAMES), "utf-8")), { "id-b": "InB" });

  rmSync(a, { recursive: true, force: true });
  rmSync(b, { recursive: true, force: true });
});
