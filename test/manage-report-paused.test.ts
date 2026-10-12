import "./home-guard.js";
/**
 * test/manage-report-paused.test.ts — the periodic "Manager report" must not
 * mention paused managers: a paused one does nothing, and "paused, 0 armings"
 * every half hour is noise the operator asked to stop receiving.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { reportLines } from "../src/daemon/manage.js";
import type { ManagedSession } from "../src/daemon/manage.js";

const NOW = Date.parse("2026-10-04T10:00:00.000Z");

function entry(name: string, over: Partial<ManagedSession> = {}): ManagedSession {
  return {
    sessionId: name, name, objective: "work", pending: [], history: [],
    lastHash: "", lastChangeAt: NOW, lastRearmAt: NOW, startedAt: NOW,
    paused: false,
    ...over,
  } as ManagedSession;
}

const noK = () => null;

test("all paused -> no lines, so nothing is sent", () => {
  const lines = reportLines([entry("a", { paused: true }), entry("b", { paused: true })], new Map(), NOW, noK);
  assert.deepEqual(lines, []);
});

test("one paused + one active -> only the active line", () => {
  const lines = reportLines([entry("a", { paused: true }), entry("b")], new Map(), NOW, noK);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^• b — working/);
});

test("reported sessions have their arming counter reset", () => {
  const armings = new Map([["b", 3]]);
  const lines = reportLines([entry("b")], armings, NOW, noK);
  assert.match(lines[0], /3 armings/);
  assert.equal(armings.get("b"), 0);
});
