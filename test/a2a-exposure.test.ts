/**
 * test/a2a-exposure.test.ts — the opt-in allowlist behind AgentCard.skills.
 *
 * Mirrors inbound.ts's rule: nothing is exposed by default, and the
 * operator names exactly what is.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expose, unexpose, listExposed, isExposed, findExposed } from "../src/a2a/exposure.js";

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "a2a-exposure-")), "exposed.json");
}

test("default: nothing exposed+", () => {
  const file = tmpFile();
  assert.deepEqual(listExposed(file), []);
  assert.equal(isExposed("Home", file), false);
});

test("expose/unexpose roundtrip+", () => {
  const file = tmpFile();
  const e = expose("Home", "the household session", file);
  assert.equal(e.name, "Home");
  assert.equal(isExposed("Home", file), true);
  assert.equal(listExposed(file).length, 1);

  assert.equal(unexpose("Home", file), true);
  assert.equal(isExposed("Home", file), false);
  assert.equal(listExposed(file).length, 0);
});

test("unexpose on something never exposed returns false", () => {
  const file = tmpFile();
  assert.equal(unexpose("Nobody", file), false);
});

test("exposing the same name twice updates rather than duplicates", () => {
  const file = tmpFile();
  expose("Home", "first description", file);
  expose("Home", "second description", file);
  assert.equal(listExposed(file).length, 1);
  assert.equal(findExposed("Home", file)?.description, "second description");
});

test("matching is case-insensitive", () => {
  const file = tmpFile();
  expose("Home", undefined, file);
  assert.equal(isExposed("HOME", file), true);
  assert.equal(isExposed("home", file), true);
});
