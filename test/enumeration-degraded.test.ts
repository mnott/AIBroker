import "./home-guard.js";
/**
 * test/enumeration-degraded.test.ts — a failed iTerm enumeration must not
 * read as a healthy, empty machine.
 *
 * Observed live 2026-09-29: osascript errored, `aibroker_sessions` returned
 * `[]`, `status` still said healthy, and nothing alerted. Pins the flag
 * (`wasLastEnumerationReliable`) surfacing through both IPC handlers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "aibroker-enum-degraded-"));
process.env.HOME = scratch;
mkdirSync(join(scratch, ".aibroker"), { recursive: true });

const { registerCoreHandlers } = await import("../src/daemon/core-handlers.js");
const { _internal, invalidateSnapshotCache } = await import("../src/adapters/iterm/core.js");
const { setAppDir } = await import("../src/core/persistence.js");
import type { IpcHandler } from "../src/ipc/server.js";

setAppDir(scratch);

function registerAndCapture(): Map<string, IpcHandler> {
  const handlers = new Map<string, IpcHandler>();
  const fakeServer = { on: (method: string, handler: IpcHandler) => handlers.set(method, handler) };
  const fakeRegistry = { list: () => [], getAllHealth: () => new Map() };
  registerCoreHandlers(fakeServer as any, fakeRegistry as any, {} as any, {} as any);
  return handlers;
}

const req = (method: string) => ({ id: "r", sessionId: "x", method, params: {} }) as any;

test("a failed osascript enumeration marks sessions and status as degraded, then clears on recovery", async () => {
  const handlers = registerAndCapture();
  const original = _internal.runItermJxa;
  try {
    // ── failure ──
    _internal.runItermJxa = () => null;
    invalidateSnapshotCache();

    const sessionsResult = (await handlers.get("sessions")!(req("sessions"))) as {
      result: { sessions: unknown[]; enumerationFailed: boolean; enumerationDetail?: string };
    };
    assert.equal(sessionsResult.result.enumerationFailed, true);
    assert.match(sessionsResult.result.enumerationDetail ?? "", /iTerm/);
    assert.deepEqual(sessionsResult.result.sessions, []);

    const statusResult = (await handlers.get("status")!(req("status"))) as {
      result: { status: string; detail?: string };
    };
    assert.equal(statusResult.result.status, "degraded");
    assert.match(statusResult.result.detail ?? "", /iTerm/);

    // ── recovery ── (truthy but parses to zero sessions — distinct from the
    // failure sentinel `null`, same convention as snapshot-cache.test.ts)
    _internal.runItermJxa = () => " ";
    invalidateSnapshotCache();

    const sessionsAfter = (await handlers.get("sessions")!(req("sessions"))) as {
      result: { enumerationFailed: boolean };
    };
    assert.equal(sessionsAfter.result.enumerationFailed, false);

    const statusAfter = (await handlers.get("status")!(req("status"))) as { result: { status: string } };
    assert.equal(statusAfter.result.status, "ok");
  } finally {
    _internal.runItermJxa = original;
    invalidateSnapshotCache();
  }
});
