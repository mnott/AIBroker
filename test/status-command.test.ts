/**
 * test/status-command.test.ts — Unit tests for /status command formatting logic.
 *
 * Tests the pure formatting logic used by the /status and /st commands
 * without requiring iTerm2 or AppleScript.
 *
 * Run: npx tsx --test test/status-command.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { StatusCache } from "../src/core/status-cache.js";
import type { StatusSnapshot } from "../src/core/status-cache.js";

// ---------------------------------------------------------------------------
// Pure formatting logic extracted for testability
// ---------------------------------------------------------------------------

interface MockSessionSnapshot {
  id: string;
  name: string;
  paiName: string | null;
  tabTitle: string | null;
  atPrompt: boolean;
}

/**
 * Mirrors the formatting logic in the /status command handler.
 * If the real handler changes, keep this in sync.
 */
function formatStatusReply(
  snapshots: MockSessionSnapshot[],
  activeItermSessionId: string,
  cache: StatusCache,
  now = Date.now(),
): string {
  if (snapshots.length === 0) return "No iTerm2 sessions found.";

  const lines: string[] = ["*Session Status*", ""];
  for (let i = 0; i < snapshots.length; i++) {
    const snap = snapshots[i];
    const label = snap.paiName ?? snap.tabTitle ?? snap.name;
    const isActive = snap.id === activeItermSessionId;

    let statusIcon: string;
    let statusLabel: string;
    const cached = cache.get(snap.id);
    if (cached && cached.state !== "idle" && !snap.atPrompt) {
      statusIcon = "🔴";
      statusLabel = "busy";
    } else if (snap.atPrompt) {
      statusIcon = "🟢";
      statusLabel = "idle";
    } else {
      statusIcon = "🟡";
      statusLabel = "working";
    }

    const activeTag = isActive ? " ← active" : "";
    lines.push(`${i + 1}. ${statusIcon} *${label}* — ${statusLabel}${activeTag}`);

    if (cached?.summary && now - cached.timestamp < 5 * 60 * 1000) {
      lines.push(`   _${cached.summary}_`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("StatusCache", () => {
  it("stores and retrieves a snapshot", () => {
    const cache = new StatusCache();
    const snap: StatusSnapshot = {
      sessionId: "abc",
      sessionName: "Test",
      timestamp: Date.now(),
      state: "idle",
      summary: "Waiting for input",
      contentHash: "abc123",
      lastProbeAt: Date.now(),
    };
    cache.set("abc", snap);
    assert.deepEqual(cache.get("abc"), snap);
  });

  it("returns undefined for unknown session", () => {
    const cache = new StatusCache();
    assert.equal(cache.get("unknown"), undefined);
  });

  it("detects content change correctly", () => {
    const cache = new StatusCache();
    const snap: StatusSnapshot = {
      sessionId: "abc",
      sessionName: "Test",
      timestamp: Date.now(),
      state: "busy",
      summary: "",
      contentHash: "hash1",
      lastProbeAt: Date.now(),
    };
    cache.set("abc", snap);
    assert.equal(cache.hasChanged("abc", "hash1"), false);
    assert.equal(cache.hasChanged("abc", "hash2"), true);
  });

  it("always returns true for unknown session on hasChanged", () => {
    const cache = new StatusCache();
    assert.equal(cache.hasChanged("unknown", "anyhash"), true);
  });

  it("touch updates lastProbeAt without changing other fields", () => {
    const cache = new StatusCache();
    const before = Date.now() - 100;
    cache.set("abc", {
      sessionId: "abc",
      sessionName: "Test",
      timestamp: before,
      state: "idle",
      summary: "old",
      contentHash: "h",
      lastProbeAt: before,
    });
    cache.touch("abc");
    const snap = cache.get("abc")!;
    assert.ok(snap.lastProbeAt >= before + 100 || snap.lastProbeAt > before);
    assert.equal(snap.summary, "old");
  });

  it("deletes a session", () => {
    const cache = new StatusCache();
    cache.set("abc", {
      sessionId: "abc", sessionName: "T", timestamp: 0, state: "idle",
      summary: "", contentHash: "", lastProbeAt: 0,
    });
    cache.delete("abc");
    assert.equal(cache.get("abc"), undefined);
  });

  it("getAll returns all cached snapshots", () => {
    const cache = new StatusCache();
    cache.set("a", { sessionId: "a", sessionName: "A", timestamp: 0, state: "idle", summary: "", contentHash: "", lastProbeAt: 0 });
    cache.set("b", { sessionId: "b", sessionName: "B", timestamp: 0, state: "busy", summary: "", contentHash: "", lastProbeAt: 0 });
    assert.equal(cache.getAll().length, 2);
  });

  it("clear removes all entries", () => {
    const cache = new StatusCache();
    cache.set("a", { sessionId: "a", sessionName: "A", timestamp: 0, state: "idle", summary: "", contentHash: "", lastProbeAt: 0 });
    cache.clear();
    assert.equal(cache.size, 0);
  });
});

describe("formatStatusReply", () => {
  it("returns no-sessions message when empty", () => {
    const cache = new StatusCache();
    assert.equal(formatStatusReply([], "", cache), "No iTerm2 sessions found.");
  });

  it("marks idle session with green icon", () => {
    const cache = new StatusCache();
    const result = formatStatusReply(
      [{ id: "s1", name: "MySession", paiName: null, tabTitle: null, atPrompt: true }],
      "",
      cache,
    );
    assert.ok(result.includes("🟢"), `Expected green icon, got: ${result}`);
    assert.ok(result.includes("idle"), `Expected 'idle', got: ${result}`);
  });

  it("marks busy session (not at prompt + cache state=busy) with red icon", () => {
    const cache = new StatusCache();
    const now = Date.now();
    cache.set("s1", {
      sessionId: "s1", sessionName: "S1", timestamp: now,
      state: "busy", summary: "", contentHash: "", lastProbeAt: now,
    });
    const result = formatStatusReply(
      [{ id: "s1", name: "MySession", paiName: null, tabTitle: null, atPrompt: false }],
      "",
      cache,
    );
    assert.ok(result.includes("🔴"), `Expected red icon, got: ${result}`);
    assert.ok(result.includes("busy"), `Expected 'busy', got: ${result}`);
  });

  it("marks working session (not at prompt, no cache) with yellow icon", () => {
    const cache = new StatusCache();
    const result = formatStatusReply(
      [{ id: "s1", name: "MySession", paiName: null, tabTitle: null, atPrompt: false }],
      "",
      cache,
    );
    assert.ok(result.includes("🟡"), `Expected yellow icon, got: ${result}`);
    assert.ok(result.includes("working"), `Expected 'working', got: ${result}`);
  });

  it("marks active session with arrow", () => {
    const cache = new StatusCache();
    const result = formatStatusReply(
      [{ id: "s1", name: "MySession", paiName: null, tabTitle: null, atPrompt: true }],
      "s1",
      cache,
    );
    assert.ok(result.includes("← active"), `Expected '← active', got: ${result}`);
  });

  it("does not mark non-active sessions with arrow", () => {
    const cache = new StatusCache();
    const result = formatStatusReply(
      [{ id: "s1", name: "MySession", paiName: null, tabTitle: null, atPrompt: true }],
      "s2",
      cache,
    );
    assert.ok(!result.includes("← active"), `Should not have arrow, got: ${result}`);
  });

  it("uses paiName over name when available", () => {
    const cache = new StatusCache();
    const result = formatStatusReply(
      [{ id: "s1", name: "iTerm name", paiName: "PAI Label", tabTitle: null, atPrompt: true }],
      "",
      cache,
    );
    assert.ok(result.includes("PAI Label"), `Expected PAI label, got: ${result}`);
    assert.ok(!result.includes("iTerm name"), `Should not show iTerm name, got: ${result}`);
  });

  it("uses tabTitle as fallback when no paiName", () => {
    const cache = new StatusCache();
    const result = formatStatusReply(
      [{ id: "s1", name: "iTerm name", paiName: null, tabTitle: "Tab Title", atPrompt: true }],
      "",
      cache,
    );
    assert.ok(result.includes("Tab Title"), `Expected tab title, got: ${result}`);
  });

  it("includes recent cached summary", () => {
    const cache = new StatusCache();
    const now = Date.now();
    cache.set("s1", {
      sessionId: "s1", sessionName: "S1", timestamp: now,
      state: "idle", summary: "Working on a refactor.", contentHash: "", lastProbeAt: now,
    });
    const result = formatStatusReply(
      [{ id: "s1", name: "S1", paiName: null, tabTitle: null, atPrompt: true }],
      "",
      cache,
      now,
    );
    assert.ok(result.includes("Working on a refactor."), `Expected summary, got: ${result}`);
  });

  it("omits stale cached summary (> 5 min old)", () => {
    const cache = new StatusCache();
    const staleTime = Date.now() - 6 * 60 * 1000;
    cache.set("s1", {
      sessionId: "s1", sessionName: "S1", timestamp: staleTime,
      state: "idle", summary: "Old summary.", contentHash: "", lastProbeAt: staleTime,
    });
    const result = formatStatusReply(
      [{ id: "s1", name: "S1", paiName: null, tabTitle: null, atPrompt: true }],
      "",
      cache,
      Date.now(),
    );
    assert.ok(!result.includes("Old summary."), `Should omit stale summary, got: ${result}`);
  });

  it("numbers sessions starting from 1", () => {
    const cache = new StatusCache();
    const result = formatStatusReply(
      [
        { id: "s1", name: "Alpha", paiName: null, tabTitle: null, atPrompt: true },
        { id: "s2", name: "Beta", paiName: null, tabTitle: null, atPrompt: false },
      ],
      "",
      cache,
    );
    assert.ok(result.includes("1."), `Expected '1.', got: ${result}`);
    assert.ok(result.includes("2."), `Expected '2.', got: ${result}`);
  });

  it("idle cache state does not force red icon", () => {
    const cache = new StatusCache();
    const now = Date.now();
    cache.set("s1", {
      sessionId: "s1", sessionName: "S1", timestamp: now,
      state: "idle", summary: "", contentHash: "", lastProbeAt: now,
    });
    // atPrompt = false but cache says idle — should show yellow (working), not red
    const result = formatStatusReply(
      [{ id: "s1", name: "S1", paiName: null, tabTitle: null, atPrompt: false }],
      "",
      cache,
    );
    assert.ok(!result.includes("🔴"), `Should not show red when cache.state=idle, got: ${result}`);
    assert.ok(result.includes("🟡"), `Expected yellow (working), got: ${result}`);
  });
});
