import "./home-guard.js";
/**
 * test/snapshot-cache.test.ts — snapshotAllSessions() must not run the
 * osascript enumeration on every call.
 *
 * Every hub IPC handler (`status`, `aibp_status`, `send_to_session`, ...) and
 * PAILot's per-message session-name lookups and its whenAtShellPrompt poll
 * call this directly, uncached. A burst of callers within the same instant —
 * an app reconnect storm, a polling loop — used to cost one full ~1.5-4s
 * blocking enumeration EACH, back to back, on the daemon's one event loop.
 * A short-TTL memo collapses a burst into one enumeration.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { snapshotAllSessions, invalidateSnapshotCache, wasLastSnapshotReliable, _internal } from "../src/adapters/iterm/core.js";

const APPLESCRIPT_OUTPUT = ["session-1", "claude (node)", "/dev/ttys001", "My Session"].join("\t");

function stubAppleScript() {
  const original = _internal.runAppleScript;
  let calls = 0;
  _internal.runAppleScript = (..._args: Parameters<typeof original>) => { calls++; return APPLESCRIPT_OUTPUT; };
  return { calls: () => calls, restore: () => { _internal.runAppleScript = original; } };
}

test("N back-to-back calls within the TTL cost exactly one enumeration", () => {
  const stub = stubAppleScript();
  try {
    invalidateSnapshotCache();
    let last;
    for (let i = 0; i < 20; i++) last = snapshotAllSessions();
    assert.equal(stub.calls(), 1, "osascript should run once for 20 back-to-back calls");
    assert.equal(last?.[0]?.id, "session-1");
  } finally {
    stub.restore();
  }
});

test("fresh:true bypasses the memo", () => {
  const stub = stubAppleScript();
  try {
    invalidateSnapshotCache();
    snapshotAllSessions();
    snapshotAllSessions();
    snapshotAllSessions({ fresh: true });
    assert.equal(stub.calls(), 2, "a fresh:true call must re-enumerate even inside the TTL window");
  } finally {
    stub.restore();
  }
});

test("invalidateSnapshotCache() forces the next call to re-enumerate", () => {
  const stub = stubAppleScript();
  try {
    invalidateSnapshotCache();
    snapshotAllSessions();
    invalidateSnapshotCache();
    snapshotAllSessions();
    assert.equal(stub.calls(), 2, "invalidation must not be satisfied by the stale cache");
  } finally {
    stub.restore();
  }
});

// ── a failed enumeration must not look identical to a confirmed empty one ──
//
// Real fault, 2026-09-23: osascript errored, snapshotAllSessions() returned
// [] (its only failure signal), and a caller a layer up read that as "this
// project has no live session" and launched one into a live Claude pane.

test("a null osascript result is reported as an unreliable enumeration", () => {
  const original = _internal.runAppleScript;
  _internal.runAppleScript = () => null;
  try {
    invalidateSnapshotCache();
    const sessions = snapshotAllSessions({ fresh: true });
    assert.deepEqual(sessions, []);
    assert.equal(wasLastSnapshotReliable(), false);
  } finally {
    _internal.runAppleScript = original;
  }
});

test("a genuine answer (even an empty session list) is reported as reliable", () => {
  const original = _internal.runAppleScript;
  // Truthy but parses to zero sessions — distinct from osascript's own failure
  // sentinel (`null`), which is what "unreliable" must actually mean here.
  _internal.runAppleScript = () => " ";
  try {
    invalidateSnapshotCache();
    const sessions = snapshotAllSessions({ fresh: true });
    assert.deepEqual(sessions, []);
    assert.equal(wasLastSnapshotReliable(), true);
  } finally {
    _internal.runAppleScript = original;
  }
});
