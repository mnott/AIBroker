import "./home-guard.js";
/**
 * A visual session registered before its pane carried the worker marker must
 * leave the list once the marker shows; an unmarked live session stays.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { HybridSessionManager } from "../src/core/hybrid.js";
import { listedLiveIds } from "../src/core/session-discovery.js";

const backend = { createSession: () => ({ id: "api-1" }), activeSessionId: "" } as never;

test("a registered pane that is now marked as a worker pane is pruned", () => {
  const m = new HybridSessionManager(backend);
  m.registerVisualSession("Keep", "", "t-1");
  m.registerVisualSession("Worker", "", "t-2");
  const live = [{ id: "t-1" }, { id: "t-2", workerPane: true }];
  assert.equal(m.pruneDeadVisualSessions(listedLiveIds(live)), 1);
  assert.deepEqual(m.knownSessions().map((s) => s.backendSessionId), ["t-1"]);
});

test("unmarked live sessions all stay", () => {
  const m = new HybridSessionManager(backend);
  m.registerVisualSession("A", "", "t-1");
  m.registerVisualSession("B", "", "t-2");
  const live = [{ id: "t-1", workerPane: false }, { id: "t-2" }];
  assert.equal(m.pruneDeadVisualSessions(listedLiveIds(live)), 0);
  assert.equal(m.knownSessions().length, 2);
});
