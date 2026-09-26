import "./home-guard.js";
/**
 * test/manage-stop.test.ts — `manage off` must end management under every key.
 *
 * managers.json is keyed by iTerm2 sessionId, and a relaunched pane gets a new
 * one. The off path resolved the name to the CURRENT id and deleted only that
 * key, so the stale same-name entry survived and the manager loop kept arming a
 * session the operator had explicitly stopped — three `off` calls in a row on
 * 2026-09-24 all answered "stopped managing <session>" while the entry stayed
 * keyed by the dead pane id.
 *
 * stopManaging is the off path's policy: drop the resolved id AND every
 * same-name entry, and return the stale keys so the caller can log them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { stopManaging } from "../src/daemon/manage.js";
import type { ManagedSession } from "../src/daemon/manage.js";

const NOW = Date.parse("2026-09-24T10:27:00.000Z");

function entry(name: string, over: Partial<ManagedSession> = {}): ManagedSession {
  return {
    sessionId: "pane", name, objective: "work", pending: [], history: [],
    lastHash: "", lastChangeAt: NOW, lastRearmAt: NOW, startedAt: NOW,
    ...over,
  } as ManagedSession;
}

test("off removes the entry keyed by the dead pane id, not only the current one", () => {
  const state: Record<string, ManagedSession> = { "dead-pane-id": entry("Alpha", { sessionId: "dead-pane-id" }) };
  const stale = stopManaging(state, "current-pane-id", "Alpha");
  assert.equal(Object.keys(state).length, 0, "the stale same-name entry must not survive the stop");
  assert.deepEqual(stale, ["dead-pane-id"], "the removed stale key is named, so the log shows the relaunch");
});

test("a relaunch that re-managed under the new id loses both entries", () => {
  const state: Record<string, ManagedSession> = {
    "dead-pane-id": entry("Alpha", { sessionId: "dead-pane-id" }),
    "current-pane-id": entry("Alpha", { sessionId: "current-pane-id" }),
  };
  const stale = stopManaging(state, "current-pane-id", "Alpha");
  assert.equal(Object.keys(state).length, 0);
  assert.deepEqual(stale, ["dead-pane-id"]);
});

test("another session's entry is not collateral damage", () => {
  const state: Record<string, ManagedSession> = {
    "dead-pane-id": entry("Alpha", { sessionId: "dead-pane-id" }),
    "other-pane-id": entry("Beta", { sessionId: "other-pane-id" }),
  };
  const stale = stopManaging(state, "current-pane-id", "Alpha");
  assert.deepEqual(Object.keys(state), ["other-pane-id"]);
  assert.deepEqual(stale, ["dead-pane-id"]);
});
