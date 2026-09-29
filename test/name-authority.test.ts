import "./home-guard.js";
/**
 * test/name-authority.test.ts — a user-chosen name outranks every generated one.
 *
 * Observed live: a relaunched session without --name got Claude Code's
 * auto-title ("X-smooth-fiddle"); `/Name X` persisted paiName="X" and set the
 * tab once — but display surfaces kept rendering the live tab title as `name`,
 * and nothing ever re-asserted the chosen name after the auto-titler's next
 * re-stamp, so the chosen name survived exactly one turn.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// audit.ts and persistence.ts resolve ~/.aibroker at import time — redirect
// before anything under src/ is imported, as the other daemon suites do.
const scratch = mkdtempSync(join(tmpdir(), "aibroker-name-authority-"));
process.env.HOME = scratch;
mkdirSync(join(scratch, ".aibroker"), { recursive: true });

const { registerCoreHandlers } = await import("../src/daemon/core-handlers.js");
const { _internal, invalidateSnapshotCache } = await import("../src/adapters/iterm/core.js");
const { reassertPersistentTitles, autoTabName } = await import("../src/adapters/iterm/sessions.js");
const { setAppDir, setPersistentSessionName } = await import("../src/core/persistence.js");
import type { IpcHandler } from "../src/ipc/server.js";
import type { SessionSnapshot } from "../src/adapters/iterm/core.js";

setAppDir(scratch);

/** Real registerCoreHandlers against a capturing fake server. */
function registerAndCapture(): Map<string, IpcHandler> {
  const handlers = new Map<string, IpcHandler>();
  const fakeServer = { on: (method: string, handler: IpcHandler) => handlers.set(method, handler) };
  registerCoreHandlers(fakeServer as any, {} as any, {} as any, {} as any);
  return handlers;
}

/** Stub osascript: snapshot enumeration vs per-session content reads. */
function stubAppleScript(snapshotLines: string[], contentLine: string) {
  const original = _internal.runItermJxa;
  _internal.runItermJxa = (script: string) => {
    if (script.includes("tab.title")) return snapshotLines.join("\n");
    if (script.includes("aSession.contents()")) return contentLine;
    return null;
  };
  return { restore: () => { _internal.runItermJxa = original; } };
}

// ── display surfaces: the chosen name is the session's name ────────────────

test("sessions surface renders paiName over the decorated tab title, tabTitle kept raw", async () => {
  setPersistentSessionName("na-named", "VoiceNotes");
  invalidateSnapshotCache();
  const stub = stubAppleScript([
    // id, process name, tty, tab title — auto-titled over the chosen name
    ["na-named", "claude (node)", "/dev/ttys001", "✳ VoiceNotes-smooth-fiddle"].join("\t"),
    // no chosen name: falls to the tab title, not the raw process string
    ["na-plain", "-zsh", "/dev/ttys002", "Plain Tab"].join("\t"),
  ], "");
  try {
    const r = await registerAndCapture().get("sessions")!({
      id: "r", sessionId: "x", method: "sessions", params: {},
    } as any);
    const sessions = (r as { ok: true; result: { sessions: Record<string, unknown>[] } }).result.sessions;
    assert.equal(sessions[0].name, "VoiceNotes", "chosen name must be what consumers render");
    assert.equal(sessions[0].tabTitle, "✳ VoiceNotes-smooth-fiddle", "raw title stays visible for debugging");
    assert.equal(sessions[0].paiName, "VoiceNotes");
    assert.equal(sessions[1].name, "Plain Tab", "unnamed session falls back to its tab title");
    assert.equal(sessions[1].tabTitle, "Plain Tab");
  } finally {
    stub.restore();
    invalidateSnapshotCache();
  }
});

test("session_content surface renders paiName over the tab title, tabTitle kept raw", async () => {
  setPersistentSessionName("na-content", "VoiceNotes");
  invalidateSnapshotCache();
  // content read answers: name, atPrompt, paiName(session var), content
  const stub = stubAppleScript(
    [["na-content", "claude (node)", "/dev/ttys001", "VoiceNotes-smooth-fiddle"].join("\t")],
    ["claude (node)", "false", "", "some terminal output"].join("\t"),
  );
  try {
    const r = await registerAndCapture().get("session_content")!({
      id: "r", sessionId: "x", method: "session_content", params: { sessionId: "na-content" },
    } as any);
    const s = (r as { ok: true; result: { session: Record<string, unknown> } }).result.session;
    assert.equal(s.name, "VoiceNotes");
    assert.equal(s.tabTitle, "VoiceNotes-smooth-fiddle");
  } finally {
    stub.restore();
    invalidateSnapshotCache();
  }
});

// ── re-assert: the daemon gets the last word over the auto-titler ──────────

function snapOf(id: string, tabTitle: string, aibrokerId?: string): SessionSnapshot {
  return {
    id, name: "claude (node)", profileName: "Default", tty: "/dev/ttysX", atPrompt: false,
    paiName: null, tabTitle, ...(aibrokerId ? { aibrokerId } : {}),
  };
}

/** Recording fakes for every visual write the re-assert can make. */
function recordingWrites() {
  const wrote: string[] = [];
  return {
    wrote,
    deps: {
      setTabName: (id: string, n: string) => wrote.push(`tab:${id}:${n}`),
      setSessionVar: (id: string, n: string) => wrote.push(`var:${id}:${n}`),
      setBadge: (id: string, n: string) => wrote.push(`badge:${id}:${n}`),
      setPaneTitle: (id: string, n: string) => { wrote.push(`pane:${id}:${n}`); return true; },
      viewerFor: (id: string) => (id === "na-tmux" ? "na-viewer" : null),
    },
  };
}

test("re-assert re-pins a diverged title, ignores benign decoration and unnamed sessions", () => {
  setPersistentSessionName("na-a", "TaskBus");
  setPersistentSessionName("na-b", "Inbox");
  const { wrote, deps } = recordingWrites();
  const repinned = reassertPersistentTitles({
    ...deps,
    sessions: [
      snapOf("na-a", "TaskBus-smooth-fiddle"), // auto-titled over the chosen name → re-pin
      snapOf("na-b", "✳ Inbox (claude)"),      // busy glyph + process suffix only → leave
      snapOf("na-c", "Anything"),              // no chosen name → leave
    ],
  });
  assert.equal(repinned, 1);
  assert.deepEqual(wrote, ["var:na-a:TaskBus", "tab:na-a:TaskBus", "badge:na-a:TaskBus"]);
});

test("re-assert on a tmux-hosted pane retitles the pane and its iTerm viewer tab", () => {
  setPersistentSessionName("na-tmux", "CaseNotes");
  const { wrote, deps } = recordingWrites();
  const repinned = reassertPersistentTitles({
    ...deps,
    sessions: [snapOf("na-tmux", "CaseNotes-smooth-fiddle", "aid-1")],
  });
  assert.equal(repinned, 1);
  assert.deepEqual(wrote, [
    "pane:na-tmux:CaseNotes",
    "var:na-viewer:CaseNotes",
    "tab:na-viewer:CaseNotes",
    "badge:na-viewer:CaseNotes",
  ]);
});

// ── auto paths may not displace a chosen name ──────────────────────────────

test("an auto-generated name yields to a chosen one, and generates when there is none", () => {
  setPersistentSessionName("na-chosen", "ChosenName");
  assert.equal(autoTabName("na-chosen", "path-basename"), "ChosenName");
  assert.equal(autoTabName("na-never-named", "path-basename"), "path-basename");
});
