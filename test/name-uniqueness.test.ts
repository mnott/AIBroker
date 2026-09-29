import "./home-guard.js";
/**
 * test/name-uniqueness.test.ts — one name, one live holder.
 *
 * Observed live (filed 2026-09-27, fault 6hf797FF): at 21:07 on 2026-09-26 a
 * second iTerm tab (38F6F78B) registered over MCP under a name a live session
 * (93CAD212, alive since 2026-09-24) already held. The store then answered the
 * name with both ids, a daemon restart bound it to the newcomer, the newcomer
 * dropped to a shell, and the dispatcher probed the corpse and parked both
 * daily sweeps — the live holder was never tried. Four invariants below:
 * theft refused, succession allowed, resolution prefers the live holder,
 * dead bindings pruned (never durable-id ones).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// persistence.ts resolves ~/.aibroker at import time — redirect before anything
// under src/ is imported, as the other daemon suites do.
const scratch = mkdtempSync(join(tmpdir(), "aibroker-name-uniqueness-"));
process.env.HOME = scratch;
mkdirSync(join(scratch, ".aibroker"), { recursive: true });

const { registerCoreHandlers } = await import("../src/daemon/core-handlers.js");
const { _internal, invalidateSnapshotCache } = await import("../src/adapters/iterm/core.js");
const { snapshotAllSessions } = await import("../src/transport/sync-facade.js");
const {
  setAppDir,
  setPersistentSessionName,
  setHolderLivenessProbe,
  getAllPersistentSessionNames,
  pruneSessionNames,
  ITERM_UUID_KEY,
} = await import("../src/core/persistence.js");
const { dispatch, findSessionsForProject } = await import("../src/daemon/dispatch.js");
const { HybridSessionManager } = await import("../src/core/hybrid.js");
import type { IpcHandler } from "../src/ipc/server.js";

setAppDir(scratch);

/**
 * A fresh store (and prune-miss counters) per test: the store is a file-backed
 * module singleton, so without this every test inherits the previous one's
 * bindings and misses.
 */
function freshStore(): string {
  const dir = mkdtempSync(join(tmpdir(), "aibroker-name-uniqueness-"));
  mkdirSync(join(dir, ".aibroker"), { recursive: true });
  setAppDir(dir);
  return dir;
}

// Neutral incident-shaped ids (real incident: 93CAD212 live, 38F6F78B thief).
const LIVE = "93CAD212-0000-4000-8000-00000000A001";
const THIEF = "38F6F78B-0000-4000-8000-00000000B002";
const OTHER = "5EBF1730-0000-4000-8000-00000000C003";

/** The daemon's wiring (daemon/index.ts): liveness read off the enumeration. */
function wireProbeFromSnapshots() {
  setHolderLivenessProbe((key) => {
    const snaps = snapshotAllSessions();
    if (snaps.length === 0) return "unknown";
    return snaps.some((s) => s.id === key || s.aibrokerId === key) ? "live" : "gone";
  });
}

/** Stub osascript: the enumeration query vs anything else. */
function stubEnumeration(lines: string[]) {
  const original = _internal.runAppleScript;
  _internal.runAppleScript = (script: string) =>
    script.includes("tab.title") ? lines.join("\n") : null;
  return { restore: () => { _internal.runAppleScript = original; } };
}

/** One enumeration row: id, process name, tty, tab title. */
const row = (id: string, proc: string, tty: string, title: string) =>
  [id, proc, tty, title].join("\t");

// ── the store: theft refused, succession allowed ────────────────────────────

test("a live holder's name is not stolen: claim refused, binding untouched", () => {
  freshStore();
  setHolderLivenessProbe(null);
  setPersistentSessionName(LIVE, "Jobs");
  wireProbeFromSnapshots();
  const stub = stubEnumeration([
    row(LIVE, "claude (node)", "/dev/ttysNU01", "Jobs"),
    row(THIEF, "claude (node)", "/dev/ttysNU02", "Jobs"),
  ]);
  invalidateSnapshotCache();
  try {
    const claim = setPersistentSessionName(THIEF, "Jobs");
    assert.equal(claim.ok, false, "theft must be refused while the holder is live");
    assert.equal(claim.heldBy, LIVE);
    assert.deepEqual(getAllPersistentSessionNames(), { [LIVE]: "Jobs" }, "holder keeps the name");
  } finally {
    stub.restore();
    setHolderLivenessProbe(null);
    invalidateSnapshotCache();
  }
});

test("self-reassert succeeds — the holder renaming itself is not theft", () => {
  freshStore();
  setHolderLivenessProbe(null);
  setPersistentSessionName(LIVE, "Jobs");
  wireProbeFromSnapshots();
  const stub = stubEnumeration([row(LIVE, "claude (node)", "/dev/ttysNU01", "Jobs")]);
  invalidateSnapshotCache();
  try {
    assert.equal(setPersistentSessionName(LIVE, "Jobs").ok, true);
  } finally {
    stub.restore();
    setHolderLivenessProbe(null);
    invalidateSnapshotCache();
  }
});

test("succession: holder verifiably gone -> claim wins and the dead binding is dropped", () => {
  freshStore();
  setHolderLivenessProbe(null);
  setPersistentSessionName(LIVE, "Jobs"); // pre-theft binding, holder since closed
  wireProbeFromSnapshots();
  const stub = stubEnumeration([row(THIEF, "claude (node)", "/dev/ttysNU02", "Jobs")]);
  invalidateSnapshotCache();
  try {
    const claim = setPersistentSessionName(THIEF, "Jobs");
    assert.equal(claim.ok, true);
    assert.deepEqual(getAllPersistentSessionNames(), { [THIEF]: "Jobs" }, "old binding removed, not shadowed");
  } finally {
    stub.restore();
    setHolderLivenessProbe(null);
    invalidateSnapshotCache();
  }
});

test("unknown enumeration allows the write but keeps the old binding (may still be live)", () => {
  freshStore();
  setHolderLivenessProbe(null);
  setPersistentSessionName(LIVE, "Jobs");
  // The daemon probe answers "unknown" when the enumeration comes back empty —
  // a hiccup must not license a theft verdict it could not verify.
  setHolderLivenessProbe(() => "unknown");
  try {
    assert.equal(setPersistentSessionName(THIEF, "Jobs").ok, true);
    assert.deepEqual(
      getAllPersistentSessionNames(),
      { [LIVE]: "Jobs", [THIEF]: "Jobs" },
      "unverifiable holder is kept; prefer-live resolution settles the dual mapping",
    );
  } finally {
    setHolderLivenessProbe(null);
  }
});

// ── the rename IPC: the refusal reaches the caller ──────────────────────────

function registerAndCapture(): Map<string, IpcHandler> {
  const handlers = new Map<string, IpcHandler>();
  const fakeServer = { on: (method: string, handler: IpcHandler) => handlers.set(method, handler) };
  const fakeRegistry = { list: () => [] as [], register() {}, unregister() {} };
  const fakeManager = { updateName() {}, listSessions: () => [] as [], activeSession: undefined };
  registerCoreHandlers(fakeServer as any, fakeRegistry as any, {} as any, fakeManager as any);
  return handlers;
}

const renameReq = (itermId: string, name: string) => ({
  id: "r", sessionId: "x", method: "rename", itermSessionId: `w0t0p0:${itermId}`, params: { name },
} as any);

test("rename over IPC: second tab cannot take a live session's name", async () => {
  freshStore();
  setHolderLivenessProbe(null);
  setPersistentSessionName(LIVE, "Jobs");
  wireProbeFromSnapshots();
  const stub = stubEnumeration([
    row(LIVE, "claude (node)", "/dev/ttysNU01", "Jobs"),
    row(THIEF, "claude (node)", "/dev/ttysNU02", "Jobs"),
  ]);
  invalidateSnapshotCache();
  try {
    const handlers = registerAndCapture();
    const refused = await handlers.get("rename")!(renameReq(THIEF, "Jobs"));
    assert.equal((refused as { ok: boolean }).ok, false);
    assert.match((refused as { error: string }).error, /held by live session/i);
    assert.deepEqual(getAllPersistentSessionNames(), { [LIVE]: "Jobs" });

    // The holder re-asserting its own name (the 2026-09-27 workaround shape)
    // must keep succeeding — this is the recovery path, not a theft.
    const reassert = await handlers.get("rename")!(renameReq(LIVE, "Jobs"));
    assert.equal((reassert as { ok: boolean }).ok, true);
    assert.deepEqual(getAllPersistentSessionNames(), { [LIVE]: "Jobs" });
  } finally {
    stub.restore();
    setHolderLivenessProbe(null);
    invalidateSnapshotCache();
  }
});

// ── resolution: the live holder wins, every same-name session is probed ─────

/** Terminal frames: a live Claude box vs a bare shell. */
const CLAUDE_FRAME = `${"─".repeat(30)}\n❯\n${"─".repeat(30)}\n  status`;
const SHELL_FRAME = "last login: Sat Sep 27 05:30:00 on ttys002\nhost ~ %";

/** PAI project whose name is the contested one. */
const project = {
  name: "jobs", names: ["jobs"], slug: "jobs", displayName: "Jobs",
  rootPath: "/dev/ai/Jobs", sessionCount: 0, lastActive: "",
} as Parameters<typeof findSessionsForProject>[0];

const namedSession = (id: string, isClaude: boolean) => ({ id, name: "Jobs (node)", paiName: "Jobs", isClaude });

test("dispatch: two same-name tabs -> the work order reaches the one running Claude", async () => {
  // Enumeration order puts the corpse first — ranking, not luck, must decide.
  const probed: string[] = [];
  const r = await dispatch("jobs", "run the sweep", {}, {
    resolve: async () => project,
    sessions: () => [namedSession(THIEF, false), namedSession(LIVE, true)],
    sessionsReliable: () => true,
    deliver: async (id) => { probed.push(id); return "ok"; },
    capture: (id) => (id === THIEF ? SHELL_FRAME : CLAUDE_FRAME),
    launch: async () => { throw new Error("a session is live — spawning is the duplicate bug"); },
    waitReady: async () => true,
    now: () => 0,
  } as Parameters<typeof dispatch>[3]);
  assert.equal(r.outcome, "delivered");
  assert.equal(r.session, "Jobs");
  assert.deepEqual(probed, [LIVE], "the corpse must not receive, or even be typed into");
});

test("dispatch: all same-name tabs at a shell -> unreachable, and the reason says all were probed", async () => {
  const r = await dispatch("jobs", "run the sweep", {}, {
    resolve: async () => project,
    sessions: () => [namedSession(THIEF, false), namedSession(LIVE, false)],
    sessionsReliable: () => true,
    deliver: async () => { throw new Error("nothing may be typed into a shell"); },
    capture: () => SHELL_FRAME,
    launch: async () => { throw new Error("same-name sessions exist — spawn would duplicate"); },
    waitReady: async () => true,
    now: () => 0,
  } as Parameters<typeof dispatch>[3]);
  assert.equal(r.outcome, "unreachable");
  assert.match(r.reason, /no longer running Claude/);
  assert.match(r.reason, /All 2 sessions.*were probed/);
});

test("findSessionsForProject ranks a measured-Claude pane above a measured shell", () => {
  const ranked = findSessionsForProject(project, [namedSession(THIEF, false), namedSession(LIVE, true)]);
  assert.equal(ranked.length, 2, "both same-name sessions are candidates, not just the first");
  assert.equal(ranked[0].id, LIVE);
  // No measurement at all: enumeration order decides, as the single-hit did.
  const unmeasured = findSessionsForProject(project, [
    { id: THIEF, name: "Jobs (node)", paiName: "Jobs" },
    { id: LIVE, name: "Jobs (node)", paiName: "Jobs" },
  ]);
  assert.equal(unmeasured[0].id, THIEF);
});

// ── pruning: a binding to a tab that no longer exists serves nobody ─────────

test("prune: UUID binding absent from a non-empty enumeration is dropped after consecutive misses", () => {
  freshStore();
  setHolderLivenessProbe(null);
  setPersistentSessionName(LIVE, "Jobs");
  // One miss, two misses — the grace period holds.
  assert.equal(pruneSessionNames([OTHER], { prunable: (key: string) => ITERM_UUID_KEY.test(key) }), 0);
  assert.equal(pruneSessionNames([OTHER], { prunable: (key: string) => ITERM_UUID_KEY.test(key) }), 0);
  assert.equal(getAllPersistentSessionNames()[LIVE], "Jobs");
  // Third consecutive miss: gone.
  assert.equal(pruneSessionNames([OTHER], { prunable: (key: string) => ITERM_UUID_KEY.test(key) }), 1);
  assert.equal(getAllPersistentSessionNames()[LIVE], undefined);
});

test("prune: an empty enumeration keeps everything, and durable-id keys are never pruned", () => {
  freshStore();
  setHolderLivenessProbe(null);
  setPersistentSessionName(LIVE, "Jobs");
  setPersistentSessionName("aid-durable-7", "Notes");
  assert.equal(pruneSessionNames([], { prunable: (key: string) => ITERM_UUID_KEY.test(key) }), 0, "empty set is not a verdict");
  // Non-empty enumeration that sees neither — the UUID key goes, the durable id stays.
  pruneSessionNames([OTHER], { prunable: (key: string) => ITERM_UUID_KEY.test(key) });
  pruneSessionNames([OTHER], { prunable: (key: string) => ITERM_UUID_KEY.test(key) });
  assert.equal(pruneSessionNames([OTHER], { prunable: (key: string) => ITERM_UUID_KEY.test(key) }), 1);
  assert.equal(getAllPersistentSessionNames()["aid-durable-7"], "Notes");
});

// ── the filing's scenario, end to end ───────────────────────────────────────
//
// Pre-fix state seeded directly into the store: the theft already happened
// (both ids carry the name), the thief tab is a shell, the real session is
// alive. A daemon restart = a fresh HybridSessionManager discovering from the
// store. Dispatch must reach the live session, not park on the corpse.

test("filing scenario: stolen name, daemon restart -> dispatch reaches the live session", async () => {
  freshStore();
  setHolderLivenessProbe(null);
  setPersistentSessionName(LIVE, "Jobs");   // the real holder, alive since 2026-09-24
  setPersistentSessionName(THIEF, "Jobs");  // the 2026-09-26 21:07 theft

  // The enumeration both the manager and dispatch read: thief first, at a
  // shell; the live session second.
  const snaps = [
    { id: THIEF, name: "-zsh", paiName: "Jobs", tabTitle: "Jobs", isClaude: false },
    { id: LIVE, name: "claude (node)", paiName: "Jobs", tabTitle: "Jobs", isClaude: true },
  ];

  // Fresh manager from the store, as after the 05:30 restart.
  const manager = new HybridSessionManager({} as any);
  manager.setDiscovery(() => snaps);
  const bound = manager.listSessions().find((s) => s.name === "Jobs");
  assert.equal(bound?.backendSessionId, LIVE, "the name binds to the tab running Claude");

  // And the dispatcher reaches the live session rather than parking.
  const delivered: string[] = [];
  const r = await dispatch("jobs", "run the sweep", {}, {
    resolve: async () => project,
    sessions: () => snaps.map((s) => ({ id: s.id, name: s.name, paiName: s.paiName, isClaude: s.isClaude })),
    sessionsReliable: () => true,
    deliver: async (id) => { delivered.push(id); return "ok"; },
    capture: (id) => (id === THIEF ? SHELL_FRAME : CLAUDE_FRAME),
    launch: async () => { throw new Error("must not spawn next to a live session"); },
    waitReady: async () => true,
    now: () => 0,
  } as Parameters<typeof dispatch>[3]);
  assert.equal(r.outcome, "delivered", "not parked — the live holder answers");
  assert.deepEqual(delivered, [LIVE]);
});
