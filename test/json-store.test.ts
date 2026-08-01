/**
 * test/json-store.test.ts — durable state files must not delete themselves.
 *
 * The shape being defended against: read -> substitute an empty default ->
 * write, which turns a briefly unreadable file into a permanently empty one on
 * the next ordinary update, with no error anywhere. Reported for the APNs token
 * store; the session-name store had the same shape with 80 entries behind it
 * and a cache that would keep truncating for the daemon's whole lifetime.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadJson, saveJson, GuardedStore } from "../src/core/json-store.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "aibroker-store-"));
}

// ── the three outcomes ──────────────────────────────────────────────────────

test("a missing file is 'missing', not an error", () => {
  const res = loadJson(join(tmp(), "nope.json"));
  assert.equal(res.status, "missing");
});

test("a corrupt file is 'unreadable' — never an empty value", () => {
  const dir = tmp();
  const p = join(dir, "s.json");
  writeFileSync(p, "{ this is not json");
  const res = loadJson(p);
  assert.equal(res.status, "unreadable", "corruption must not be reported as absence");
  rmSync(dir, { recursive: true, force: true });
});

test("a good file parses", () => {
  const dir = tmp();
  const p = join(dir, "s.json");
  writeFileSync(p, JSON.stringify({ a: 1 }));
  const res = loadJson<{ a: number }>(p);
  assert.equal(res.status, "ok");
  assert.equal(res.status === "ok" && res.data.a, 1);
  rmSync(dir, { recursive: true, force: true });
});

// ── the data loss itself ────────────────────────────────────────────────────

test("a corrupt store is NOT overwritten by a subsequent save", () => {
  // The exact reported failure: register a device against an unreadable token
  // file and every previously registered device disappears.
  const dir = tmp();
  const p = join(dir, "apns-tokens.json");
  const original = '["token-a","token-b" CORRUPTED';
  writeFileSync(p, original);

  const store = new GuardedStore<string[]>(p, () => [], "[test]");
  const tokens = store.load();
  assert.deepEqual(tokens, [], "load still yields a usable empty value");
  assert.equal(store.isBlocked(), true, "but the store knows it could not be read");

  tokens.push("token-new");
  assert.equal(store.save(), false, "save must refuse");
  assert.equal(readFileSync(p, "utf-8"), original, "the file on disk must be untouched");

  rmSync(dir, { recursive: true, force: true });
});

test("one unreadable read does not poison the store forever", () => {
  // The caching version of the bug: a single transient failure at startup kept
  // truncating every later write, long after the file was readable again.
  const dir = tmp();
  const p = join(dir, "names.json");
  writeFileSync(p, "NOT JSON");

  const store = new GuardedStore<Record<string, string>>(p, () => ({}), "[test]");
  store.load();
  assert.equal(store.isBlocked(), true);

  // Operator fixes the file; a reset re-reads it and unblocks.
  writeFileSync(p, JSON.stringify({ id1: "PAI" }));
  store.reset();
  assert.deepEqual(store.load(), { id1: "PAI" });
  assert.equal(store.isBlocked(), false);
  assert.equal(store.save(), true);

  rmSync(dir, { recursive: true, force: true });
});

test("a missing store saves normally — absence is legitimate", () => {
  const dir = tmp();
  const p = join(dir, "fresh.json");
  const store = new GuardedStore<string[]>(p, () => [], "[test]");
  store.load().push("first");
  assert.equal(store.save(), true);
  assert.deepEqual(JSON.parse(readFileSync(p, "utf-8")), ["first"]);
  rmSync(dir, { recursive: true, force: true });
});

// ── write durability ────────────────────────────────────────────────────────

test("saving keeps the previous contents as .bak", () => {
  const dir = tmp();
  const p = join(dir, "s.json");
  saveJson(p, { v: 1 });
  saveJson(p, { v: 2 });
  assert.deepEqual(JSON.parse(readFileSync(p, "utf-8")), { v: 2 });
  assert.deepEqual(JSON.parse(readFileSync(`${p}.bak`, "utf-8")), { v: 1 });
  rmSync(dir, { recursive: true, force: true });
});

test("saving leaves no temp file behind", () => {
  const dir = tmp();
  const p = join(dir, "s.json");
  saveJson(p, { v: 1 });
  assert.equal(existsSync(`${p}.tmp`), false);
  rmSync(dir, { recursive: true, force: true });
});

test("a failed write does not destroy the existing file", () => {
  const dir = tmp();
  const p = join(dir, "s.json");
  saveJson(p, { v: "original" });
  // Unserialisable payload: the write throws before the rename can land.
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.throws(() => saveJson(p, circular));
  assert.deepEqual(JSON.parse(readFileSync(p, "utf-8")), { v: "original" });
  assert.equal(existsSync(`${p}.tmp`), false, "temp file must be cleaned up");
  rmSync(dir, { recursive: true, force: true });
});

test("an unwritable path reports failure instead of throwing out of save()", () => {
  const dir = tmp();
  const p = join(dir, "s.json");
  saveJson(p, ["a"]);
  const store = new GuardedStore<string[]>(p, () => [], "[test]");
  store.load();
  chmodSync(dir, 0o500); // read+execute only: no new files, no rename
  try {
    assert.equal(store.save(), false, "should report failure, not throw");
  } finally {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});
