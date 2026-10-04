import "./home-guard.js";
/**
 * test/worker-pane-hidden.test.ts — a `pai worker follow` pane (iTerm variable
 * user.paiWorkerPane) stays in the raw snapshot but is absent from every list.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "aibroker-worker-pane-"));
process.env.HOME = scratch;
mkdirSync(join(scratch, ".aibroker"), { recursive: true });

const { _internal, invalidateSnapshotCache, snapshotAllSessions } = await import("../src/adapters/iterm/core.js");
const { getSessionList, listClaudeSessions } = await import("../src/adapters/iterm/sessions.js");
const { isClaudeRelated } = await import("../src/core/session-discovery.js");
const { registerCoreHandlers } = await import("../src/daemon/core-handlers.js");
const { setAppDir } = await import("../src/core/persistence.js");
import type { IpcHandler } from "../src/ipc/server.js";

setAppDir(scratch);

// id, name, tty, tab.title, user.paiWorkerPane
const JXA = [
  "REAL\tclaude (node)\t/dev/ttys901\t\t",
  "WORKER\tpai (node)\t/dev/ttys902\t\tdGVzdA==",
].join("\n") + "\n";

test("worker pane is kept in the snapshot but hidden from every list", async () => {
  const original = _internal.runItermJxa;
  try {
    _internal.runItermJxa = () => JXA;
    invalidateSnapshotCache();

    const snaps = snapshotAllSessions({ fresh: true });
    assert.equal(snaps.find((s) => s.id === "WORKER")?.workerPane, true);
    assert.equal(snaps.find((s) => s.id === "REAL")?.workerPane, false);
    assert.equal(isClaudeRelated(snaps.find((s) => s.id === "WORKER")!), false);
    assert.equal(isClaudeRelated(snaps.find((s) => s.id === "REAL")!), true);

    assert.deepEqual(getSessionList().map((s) => s.id), ["REAL"]);
    assert.deepEqual(listClaudeSessions().map((s) => s.id), ["REAL"]);

    const handlers = new Map<string, IpcHandler>();
    registerCoreHandlers(
      { on: (m: string, h: IpcHandler) => handlers.set(m, h) } as any,
      { list: () => [], getAllHealth: () => new Map() } as any,
      {} as any,
      {} as any,
    );
    invalidateSnapshotCache();
    const res = (await handlers.get("sessions")!({ id: "r", sessionId: "x", method: "sessions", params: {} } as any)) as {
      result: { sessions: { sessionId: string }[] };
    };
    assert.deepEqual(res.result.sessions.map((s) => s.sessionId), ["REAL"]);
  } finally {
    _internal.runItermJxa = original;
    invalidateSnapshotCache();
  }
});
