import "./home-guard.js";
/**
 * test/send-to-session-identity.test.ts — three faults in session identity /
 * enumeration for send_to_session.
 *
 * A) A failed/empty iTerm enumeration must not be reported as "session not
 *    found" — that is a lie when iTerm never actually answered. It must
 *    retry, and if it still cannot confirm, queue to the session's mailbox
 *    by its last known (persisted) name rather than drop the message.
 *
 * B) The `[Session:X]` prefix and the mailbox "from" label must be the
 *    sender's persistent (paiName), or a stable id — never the raw iTerm
 *    session name, which for a Claude Code pane is the terminal's own
 *    dynamic title (a spinner glyph plus tab title while busy).
 *
 * C) A caller whose claimed identity does not match any live session (a
 *    worker child process fabricates one rather than claim the pane it
 *    inherited env vars from — see ipc/client.ts) must not be attributed to
 *    the pane it happens to share a tty with. It gets a distinct label that
 *    cannot be replied to as if it were a real session.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// audit.ts and persistence.ts resolve ~/.aibroker at import time — must be
// redirected before anything under src/daemon/ is imported, or the suite
// writes into the real trail and the real session-names store.
const scratch = mkdtempSync(join(tmpdir(), "aibroker-s2s-identity-"));
process.env.HOME = scratch;
mkdirSync(join(scratch, ".aibroker"), { recursive: true });

const { registerCoreHandlers, callerItermId, resolveSenderLabel } = await import("../src/daemon/core-handlers.js");
// `live bindings`: the module namespace is passed through, so a rebinding of
// wasLastSnapshotReliable below reaches core.ts's own internal call sites.
const coreImport: typeof import("../src/adapters/iterm/core.js") & { live?: true } = await import("../src/adapters/iterm/core.js");
const _internal = coreImport._internal;
const invalidateSnapshotCache = coreImport.invalidateSnapshotCache;
const { setAppDir, setPersistentSessionName } = await import("../src/core/persistence.js");
const { drainSessionMailbox } = await import("../src/core/state.js");
import type { IpcRequest } from "../src/types/ipc.js";
import type { IpcHandler } from "../src/ipc/server.js";
import type { SessionSnapshot } from "../src/adapters/iterm/core.js";

setAppDir(scratch);

/** Real registerCoreHandlers, minus the parts send_to_session never touches. */
function registerAndCapture(): Map<string, IpcHandler> {
  const handlers = new Map<string, IpcHandler>();
  const fakeServer = { on: (method: string, handler: IpcHandler) => handlers.set(method, handler) };
  registerCoreHandlers(fakeServer as any, {} as any, {} as any, {} as any);
  return handlers;
}

/** One live Claude session, tab-title/name distinct from its paiName. */
const APPLESCRIPT_ONE_LIVE_SESSION = [
  "session-live-1", "claude (node)", "/dev/ttys001", "◑ Generic session content (claude)",
].join("\t");

/**
 * The JXA slot is ONE module-level function shared by every stubbed test in
 * this file (the A-tests below swap it and restore at a fixed moment), so all
 * of them run under this mutex: only one holds the slot at a time. (Without
 * it, install/restore interleaved and whichever restore landed last put the
 * REAL osascript back mid-test — observed: deliveredTo 0.) Declared before the
 * first test() call because node starts tests as they are registered.
 */
let stubChain: Promise<unknown> = Promise.resolve();
function withStubLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = stubChain.then(fn);
  stubChain = run.catch(() => {}); // a failure must not poison the next holder
  return run;
}

/**
 * The facade's merged memo answers from memory for STALE_LIMIT_MS, and its
 * epoch only moves when core's cache is invalidated — dropping the memo alone
 * would leave an old (real-machine) row set answering. Invalidation makes the
 * next call re-enumerate instead of serving the stale rows.
 */
async function dropFacadeMemo() {
  const facade = await import("../src/transport/sync-facade.js");
  facade.invalidateSnapshotMemoForTests();
  coreImport.invalidateSnapshotCache();
  coreImport._resetEnumBackoffForTest(); // a failed-enumeration test leaves a 60s back-off that would starve the next fixture
}

function req(fields: Partial<IpcRequest>): IpcRequest {
  return { id: "r1", sessionId: "unknown-session", method: "send_to_session", params: {}, ...fields } as IpcRequest;
}

// ── A: a failed enumeration must retry, then queue — never "not found" ─────

test("A: an unreliable/empty enumeration retries and then queues by the persisted name, not \"not found\"", () => withStubLock(async () => {
  setPersistentSessionName("session-live-1", "AIBroker");
  invalidateSnapshotCache();
  const original = _internal.runItermJxa;
  // Every enumeration in this test fails — retries never see a live session.
  _internal.runItermJxa = () => null;
  try {
    const handlers = registerAndCapture();
    const send = handlers.get("send_to_session")!;
    const r = await send(req({ params: { target: "AIBroker", message: "hello" } }));
    assert.equal(r.ok, true, `expected ok:true (queued), got: ${JSON.stringify(r)}`);
    const result = (r as { ok: true; result: Record<string, unknown> }).result;
    assert.equal(result.queued, true);
    assert.equal(result.delivered, false);
    assert.equal(result.sessionId, "session-live-1", "queued under the id the name was last known by");

    const mailbox = drainSessionMailbox("session-live-1");
    assert.equal(mailbox.length, 1);
    assert.equal(mailbox[0].content, "hello");
  } finally {
    _internal.runItermJxa = original;
    invalidateSnapshotCache();
    await dropFacadeMemo(); // a stubbed run must not sit in the facade memo for later tests
  }
}));

test("A: a RELIABLE enumeration that genuinely has no match still reports \"not found\"", () => withStubLock(async () => {
  // The fix must not paper over a real absence — only an unreliable answer.
  invalidateSnapshotCache();
  const original = _internal.runItermJxa;
  _internal.runItermJxa = () => APPLESCRIPT_ONE_LIVE_SESSION; // answers, just has nobody named this
  try {
    const handlers = registerAndCapture();
    const send = handlers.get("send_to_session")!;
    const r = await send(req({ params: { target: "NoSuchSession", message: "hello" } }));
    assert.equal(r.ok, false);
    assert.match((r as { ok: false; error: string }).error, /not found/);
  } finally {
    _internal.runItermJxa = original;
    invalidateSnapshotCache();
    await dropFacadeMemo(); // ditto
  }
}));

// ── B: sender label is the persistent name, never the raw dynamic title ────
//
// resolveSenderLabel() is exactly what send_to_session calls to build the
// mailbox "from" field and the `[Session:X]` prefix — tested directly rather
// than through the full delivery pipeline (shell/input-line checks, submit
// confirmation) which needs a real terminal to poll and is exercised
// elsewhere (send-to-session-ack.test.ts, caller-iterm-id.test.ts).

test("B: a live sender with a paiName is labelled by that name, not its tab title", () => {
  const snapshots: SessionSnapshot[] = [{
    id: "session-sender-1",
    name: "✳ Generic session content (claude)",
    profileName: "Default",
    tabTitle: null,
    tty: "/dev/ttys002",
    atPrompt: false,
    paiName: "PAI",
  }];
  const label = resolveSenderLabel(req({ itermSessionId: "session-sender-1" }), snapshots);
  assert.equal(label, "PAI");
});

test("B: a live sender with NO paiName falls back to its stable id, never the dynamic title", () => {
  // Production evidence: actor recorded as "session:◑ Generic session
  // content (claude)" — the spinner-glyph tab title, not an identity.
  const snapshots: SessionSnapshot[] = [{
    id: "session-sender-1",
    name: "◑ Generic session content (claude)",
    profileName: "Default",
    tabTitle: null,
    tty: "/dev/ttys002",
    atPrompt: false,
    paiName: null,
  }];
  const label = resolveSenderLabel(req({ itermSessionId: "session-sender-1" }), snapshots);
  assert.equal(label, "session-sender-1");
  assert.ok(!label.includes("Generic session content"), "must never fall back to the raw tab title");
});

// ── C: an identity that matches no live session gets a non-replyable label ─

test("C: a claimed id belonging to no live session is returned as-is, never upgraded to a live one", () => {
  // This is the mechanism a worker relies on (ipc/client.ts fabricates an id
  // like "worker-12345" instead of forwarding the pane owner's inherited,
  // live one — see ipc/client.ts) — callerItermId() must not go looking for
  // a live session to attribute it to besides an exact id match.
  const claimed = "worker-99999";
  assert.equal(callerItermId(req({ itermSessionId: claimed })), claimed);
});

test("C: a worker-shaped sender id is labelled by itself, not by the pane it shares a tty with", () => {
  // The pane owner IS live and IS in the snapshot — proving the label isn't
  // simply "whichever session comes first" but genuinely requires an id match.
  const snapshots: SessionSnapshot[] = [{
    id: "session-live-1",
    name: "claude (node)",
    profileName: "Default",
    tabTitle: null,
    tty: "/dev/ttys001",
    atPrompt: false,
    paiName: "AIBroker",
  }];
  const label = resolveSenderLabel(req({ itermSessionId: "worker-42" }), snapshots);
  assert.equal(label, "worker-42");
  assert.notEqual(label, "AIBroker", "a worker must never be attributed to the pane owner's identity");
});

// ── cache beats (noReply) ──
const { sendToSessionDelivery } = await import("../src/daemon/core-handlers.js");
const { mailboxWait } = await import("../src/daemon/mailbox-cli.js");
const { depositToSessionMailbox, peekSessionMailbox } = await import("../src/core/state.js");

test("beat: noReply is labelled [Keepalive], not [Session:..], and marked kind=beat in the mailbox", () => {
  const d = sendToSessionDelivery("keepalive", "pai-cli", true);
  assert.match(d.typed, /^\[Keepalive\] /);
  assert.ok(!d.typed.includes("[Session:"));
  assert.equal(d.deposit, true);
  assert.match(sendToSessionDelivery("hi", "pai-cli", false).typed, /^\[Session:pai-cli\]/);
  depositToSessionMailbox("beat-box", "pai-cli", "keepalive", "beat");
  assert.equal(peekSessionMailbox("beat-box")[0].kind, "beat");
});

function fakeClock(peeks: Array<Array<{ from: string; content: string; kind?: string }>>) {
  let t = 1_700_000_000_000;
  const out: string[] = [];
  let n = 0;
  return {
    out,
    /** Total milliseconds slept — how long the wait took on the fake clock. */
    get slept() { return t - 1_700_000_000_000; },
    deps: {
      peek: async () => peeks[Math.min(n++, peeks.length - 1)],
      sleep: async (ms: number) => { t += ms; },
      now: () => t,
      out: (l: string) => { out.push(l); },
    },
  };
}

/** Like fakeClock but sleeps on the real clock, so a --follow loop can be observed. */
function liveClock(peeks: Array<Array<{ from: string; content: string; kind?: string }>>) {
  const out: string[] = [];
  let n = 0;
  let stopped = false;
  return {
    out,
    /** Park the follow loop (its sleep never resolves) so the test process can end. */
    stop: () => { stopped = true; },
    deps: {
      peek: async () => peeks[Math.min(n++, peeks.length - 1)],
      sleep: (ms: number) => (stopped ? new Promise<void>(() => {}) : new Promise<void>((r) => setTimeout(r, Math.min(ms, 20)))),
      now: () => Date.now(),
      out: (l: string) => { out.push(l); },
    },
  };
}
const beat = { from: "pai-cli", content: "keepalive", kind: "beat" };
const real = { from: "alice", content: "hello" };

test("beat: mailbox wait ignores a beat and still exits on a real message", async () => {
  const c = fakeClock([[beat], [beat], [beat, real]]);
  assert.equal(await mailboxWait(["--heartbeat", "0"], c.deps), 0);
  assert.equal(c.out.length, 1);
  assert.match(c.out[0], /^alice \| /);
});

test("beat: heartbeat line printed at the interval while waiting", async () => {
  const c = fakeClock([[beat]]);
  assert.equal(await mailboxWait(["--timeout", "125", "--heartbeat", "60"], c.deps), 2);
  assert.equal(c.out.length, 2);
  assert.match(c.out[0], /^waiting since \d\d:\d\d$/);
});

test("beat: --heartbeat 0 prints nothing while waiting", async () => {
  const c = fakeClock([[beat]]);
  assert.equal(await mailboxWait(["--timeout", "5000", "--heartbeat", "0"], c.deps), 2);
  assert.deepEqual(c.out, []);
});

// ── --settle: a burst wakes the session once ─────────────────────────────────
const m1 = { from: "a1", content: "one" };
const m2 = { from: "a2", content: "two" };
const m3 = { from: "a3", content: "three" };

test("settle: a burst of 3 messages 2 s apart returns once, after the settle window", async () => {
  // arrival per peek index; peek 0 is empty (arrival at t=1 s), then one new
  // message every 2 s for three, then quiet.
  const arrivals = [[], [m1], [m1, m2], [m1, m2, m3], [m1, m2, m3]];
  const c = fakeClock(arrivals);
  assert.equal(await mailboxWait(["--heartbeat", "0", "--timeout", "3600", "--settle", "5"], c.deps), 0);
  assert.equal(c.out.length, 3); // one wake, all three lines together
  assert.deepEqual(c.out.map((l) => l.split(" | ")[0]), ["a1", "a2", "a3"]);
  // m3 first seen at t=4 s (peek 3), quiet for a full 5 s window -> t=9 s; the
  // last sleep is clamped to the wake moment, so slept = 8 s.
  assert.equal(c.slept, 8_000);
});

test("settle: a single message returns after the settle window, not at the arrival", async () => {
  const c = fakeClock([[], [m1]]);
  assert.equal(await mailboxWait(["--heartbeat", "0", "--timeout", "3600", "--settle", "5"], c.deps), 0);
  assert.equal(c.out.length, 1);
  // first arrival at t=1 s (peek 1), then a full quiet window -> t=6 s.
  assert.equal(c.slept, 6_000);
});

test("settle: the cap holds under a steady trickle — one wake within 60 s of the first arrival", async () => {
  // one new message every poll (1 s), forever: the window never goes quiet, so
  // the hard cap from the first arrival must end the collection.
  const arrivals: Array<Array<{ from: string; content: string; kind?: string }>> = [];
  for (let i = 0; i <= 65; i++) arrivals.push(Array.from({ length: i + 1 }, (_, j) => ({ from: `f${j}`, content: `msg${j}` })));
  const c = fakeClock(arrivals);
  assert.equal(await mailboxWait(["--heartbeat", "0", "--timeout", "3600", "--settle", "20"], c.deps), 0);
  // first arrival at t=1 s, cap 60 s -> return by t=61 s, with everything the
  // peeks saw up to then delivered together (the trickle keeps coming; nothing
  // is dropped — aibroker_receive still reads them all).
  assert.ok(c.slept <= 61_000, `slept ${c.slept}`);
  assert.equal(c.out.length, c.slept / 1000 + 1); // one message per second slept
});

test("settle: --settle 0 returns at the first message (old behaviour)", async () => {
  const c = fakeClock([[], [m1], [m1, m2]]);
  assert.equal(await mailboxWait(["--heartbeat", "0", "--settle", "0"], c.deps), 0);
  assert.equal(c.out.length, 1); // only the first message, no window
  assert.equal(c.slept, 1_000);
});

test("settle: default is on (20 s) — a burst settles into one wake without the flag", async () => {
  const c = fakeClock([[], [m1], [m1, m2]]);
  assert.equal(await mailboxWait(["--heartbeat", "0"], c.deps), 0);
  assert.equal(c.out.length, 2); // m2 landed during the default window and is delivered together
});

// ── --follow: stream, never exit ───────────────────────────────────────────────

test("follow: two messages print two lines and the waiter keeps running (no exit)", async () => {
  const c = liveClock([[], [m1], [m1], [m1, m2]]);
  const p = mailboxWait(["--heartbeat", "0", "--settle", "0", "--follow"], c.deps);
  await new Promise((r) => setTimeout(r, 400)); // let it stream past both arrivals
  assert.equal(c.out.length, 2);
  assert.deepEqual(c.out.map((l) => l.split(" | ")[0]), ["a1", "a2"]);
  // The promise must still be pending: --follow never exits on a message.
  const settled = await Promise.race([p.then(() => "exited"), new Promise((r) => setTimeout(() => r("pending"), 50))]);
  assert.equal(settled, "pending");
  c.stop();
});

test("follow: a keepalive beat emits nothing and does not wake it", async () => {
  const c = liveClock([[beat]]);
  const p = mailboxWait(["--heartbeat", "0", "--settle", "0", "--follow"], c.deps);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(c.out, []); // beats are ignored; the loop stays alive
  c.stop();
  void p;
});

test("follow: the waiter heartbeat stays registered while streaming", async () => {
  const { registerMailboxWaiter, hasActiveWaiter } = await import("../src/core/state.js");
  let heartbeats = 0;
  let stopped = false;
  const p = mailboxWait(["--heartbeat", "0", "--settle", "0", "--follow"], {
    // In the real CLI every peek calls session_mailbox_peek with waiter: true,
    // which registers the waiter (state.ts registerMailboxWaiter). The fake
    // mirrors that: each poll is a heartbeat.
    peek: async () => { heartbeats++; registerMailboxWaiter("follow-test", Date.now()); return []; },
    sleep: (ms) => (stopped ? new Promise<void>(() => {}) : new Promise<void>((r) => setTimeout(r, Math.min(ms, 20)))),
    now: () => Date.now(),
    out: () => {},
  });
  await new Promise((r) => setTimeout(r, 300));
  stopped = true;
  void p;
  assert.ok(heartbeats >= 2, "the follow loop keeps polling (heartbeat beats)");
  assert.ok(hasActiveWaiter("follow-test"), "waiter stays active while streaming");
});

// ── broadcast: fan-out to all live claude sessions, answers, roll-call ───────
//
// `aibroker broadcast` shouts a message into the mailbox of every live Claude
// session except the sender (mailbox-only — nothing typed anywhere, so no part
// of this needs a real terminal; the JXA stub answers `sessions` only). Shell
// tabs are skipped: they would execute the shout, not read it. With --ask a
// reply is recorded and lands in the sender's mailbox, and after the deadline
// an unanswered recipient reads "silent" — or "no-objection" ONLY when the
// sender passed defaultOk: silence is not agreement unless it was declared so.

const { broadcastRecipients, createBroadcast, recordBroadcastReply, getBroadcastStatus, statusFor, parseDeadlineSec, notifyBroadcastSummary, summaryDueAt, composeSummaryText, _resetLedgerCache } = await import("../src/daemon/broadcast-core.js");
const { broadcast: broadcastCli } = await import("../src/daemon/broadcast-cli.js");

process.env.AIBROKER_STATE_DIR = join(scratch, ".aibroker"); // the ledger file lives here too

/**
 * A per-test enumeration stub, run under withStubLock — the module-level JXA
 * slot is shared state and tests run concurrently, so a swapped-in global gets
 * yanked out from under a running test (observed: deliveredTo 0).
 *
 * Rows are tab-separated JXA fields (id, name, tty, tabTitle, workerPane,
 * path). `isClaude` comes from the process table keyed on the tty: a non-empty
 * table marks these PRIVATE ttys false (measured wins over any heuristic), so
 * this stub answers "" for it — an empty ps output leaves isClaude undefined
 * and the documented title fallback decides ("(node)" is a session, "-zsh" at
 * prompt is a shell).
 */
async function privateStub(rows: string[][]) {
  const coreMod = await import("../src/adapters/iterm/core.js");
  // The stub answers EVERY enumeration call in the test, whatever script is
  // passed (the A-tests' bare stubs do the same): keying on the script text
  // made a changed enum script fall through to the REAL osascript — which
  // enumerates this machine's real tabs and starves the fixture (deliveredTo 0).
  coreMod._internal.runItermJxa = () => (rows.length ? rows.map((r) => r.join("\t")).join("\n") : ""); // no rows = "iTerm answered nothing" → marker fires
  // The process table is read by runCaptureAsync (execFile), NOT the JXA stub,
  // and a direct call inside the module cannot be swapped from outside — so it
  // goes through _internal, like every other JXA primitive does for exactly
  // this reason. An empty `ps` output means "table unreadable" → isClaude
  // undefined → the title heuristic decides. A real ps on this machine would
  // mark our private ttys measured-shells and starve the fan-out to zero.
  coreMod._internal.runPsTtys = () => Promise.resolve("");
  const facade = await import("../src/transport/sync-facade.js");
  facade.setTransportOverrideForTests("iterm"); // the tmux host's panes are not our fixture
  await dropFacadeMemo(); // never answer from another enumeration's memo (see dropFacadeMemo)
  return coreMod;
}

/**
 * The enumeration's own caches (adapters/iterm memo, discovery's last-good
 * replay) sit BELOW core-handlers' listedSessions, so one test could be
 * answered from another's rows. Every layer gets a bypass: listedSessions asks
 * `fresh` (discovery drops its replay on it), the facade memo is dropped in
 * privateStub, and an EMPTY stub answer marks the enumeration unreliable —
 * which is what stops the core memo caching those rows at all. The marker is
 * consumed by exactly one enumeration call (the test's first).
 */
const origRunItermJxa = _internal.runItermJxa;
_internal.runItermJxa = (script?: string, timeoutMs?: number) => {
  const r = origRunItermJxa(script, timeoutMs);
  if (r === "") _internal.markEnumUnreliableForTests(); // empty stub: iTerm answered nothing — do not cache/replay it
  return r;
};

const BC_SENDER = "bc-sender-pane";
const BC_ANSWERER = "bc-answerer-pane";
const SHOUT = "I need the screen controls (clickr) for ~5 min, ok?";

function baseRows(): string[][] {
  return [
    [BC_SENDER, "claude (node)", "/dev/ttys901", "◑ Sender (claude)", "", ""],
    [BC_ANSWERER, "claude (node)", "/dev/ttys902", "◑ Answerer (claude)", "", ""],
    ["bc-bystander-pane", "claude (node)", "/dev/ttys903", "◑ Bystander (claude)", "", ""],
    // Named like a leftover shell tab, but NOT at a prompt — the heuristic that
    // reads "something is running here" first. A row AT a prompt with this
    // title would be a shell (the `sessions` list's own kind rule).
    ["bc-shell-tab", "node /x/watcher.js", "/dev/ttys904", "leftover shell", "", ""],
  ];
}

test("broadcast recipients: live claude sessions only, sender excluded, shells never asked", () => {
  const ids = broadcastRecipients([
    { id: BC_SENDER, paiName: "Sender", isClaude: true },
    { id: BC_ANSWERER, paiName: "Answerer", isClaude: true },
    { id: "bc-shell-tab", paiName: null, tabTitle: "leftover shell", name: "-zsh", atPrompt: true, isClaude: false },
    // Unmeasured (isClaude undefined): the title heuristic decides.
    { id: "bc-unmeasured-claude", paiName: null, tabTitle: "◑ Work (claude)", name: "claude (node)", atPrompt: false },
    { id: "bc-unmeasured-shell", paiName: null, tabTitle: "leftover shell", name: "-zsh", atPrompt: true },
  ], BC_SENDER).map((r) => r.sessionId);
  assert.ok(ids.includes(BC_ANSWERER));
  assert.ok(ids.includes("bc-unmeasured-claude"));
  assert.ok(!ids.includes(BC_SENDER), "the sender never receives its own shout");
  assert.ok(!ids.includes("bc-shell-tab"), "a shell would execute the message, not read it");
  assert.ok(!ids.includes("bc-unmeasured-shell"));
});

function bcRecord(over: Partial<import("../src/daemon/broadcast-core.js").BroadcastRecord> = {}): import("../src/daemon/broadcast-core.js").BroadcastRecord {
  return {
    id: "abc234", senderId: BC_SENDER, senderName: "Sender", message: SHOUT, ask: true,
    deadlineAt: 1000, defaultOk: false, createdAt: 0,
    recipients: [{ sessionId: BC_ANSWERER, name: "Answerer" }], replies: [], ...over,
  };
}

test("broadcast status after the deadline: silence is silent without --default-ok…", () => {
  const b = bcRecord();
  assert.equal(statusFor(b, b.recipients[0], 2000).status, "silent");
});

test("broadcast status after the deadline: …no-objection only WITH --default-ok; before it, pending; a reply wins", () => {
  const d = bcRecord({ defaultOk: true });
  assert.equal(statusFor(d, d.recipients[0], 2000).status, "no-objection");
  const b = bcRecord();
  assert.equal(statusFor(b, b.recipients[0], 500).status, "pending");
  b.replies.push({ sessionId: BC_ANSWERER, name: "Answerer", answer: "hold", reason: "mid-deploy", at: 600 });
  const row = statusFor(b, b.recipients[0], 2000);
  assert.equal(row.status, "hold");
  assert.equal(row.reason, "mid-deploy");
});

test("broadcast deadline parsing: 2m / 90s / bare seconds / nonsense", () => {
  assert.equal(parseDeadlineSec("2m"), 120);
  assert.equal(parseDeadlineSec("90s"), 90);
  assert.equal(parseDeadlineSec(45), 45);
  assert.equal(parseDeadlineSec("1h"), 3600);
  assert.equal(parseDeadlineSec("soon"), null);
});

test("broadcast ledger round-trip: create, reply into the ledger, roll-call; unknown id refused", () => {
  _resetLedgerCache();
  // A deadline in the real future: `pending` must not depend on a fake clock —
  // getBroadcastStatus reads Date.now(), so a fixed epoch is always "passed".
  const rec = createBroadcast({
    senderId: BC_SENDER, senderName: "Sender", message: SHOUT, ask: true, deadlineSec: 120, defaultOk: false,
    recipients: [{ sessionId: BC_ANSWERER, name: "Answerer" }],
  });
  assert.match(drainSessionMailbox(BC_ANSWERER)[0].content, new RegExp(`\\[Broadcast:Sender\\] ${SHOUT.replace(/[()~.?]/g, "\\$&")}`));

  const r = recordBroadcastReply(rec.id, BC_ANSWERER, "Answerer", "hold", "mid-deploy");
  assert.equal(r.ok, true, JSON.stringify(r));
  // A reply is ledgered, not messaged: the sender gets ONE summary when all
  // answered — here that fires on the notify call, not per reply.
  assert.deepEqual(drainSessionMailbox(BC_SENDER), [], "no mailbox message per reply");

  assert.equal(getBroadcastStatus(rec.id)!.rows[0].status, "hold");
  const after = getBroadcastStatus(rec.id, Date.now() + 200_000)!;
  assert.equal(after.deadlinePassed, true);
  // The one who answered still reads hold — the deadline only labels silence.
  assert.equal(after.rows[0].status, "hold");

  const unknown = recordBroadcastReply("nosuchid", BC_ANSWERER, "Answerer", "ok", undefined);
  assert.equal(unknown.ok, false);

  // An unanswered ask whose deadline has NOT passed reads pending.
  const rec2 = createBroadcast({ senderId: BC_SENDER, senderName: "Sender", message: "quick one", ask: true, deadlineSec: 120, defaultOk: false, recipients: [{ sessionId: "bc-quiet-pane", name: "Quiet" }] });
  drainSessionMailbox("bc-quiet-pane");
  assert.equal(getBroadcastStatus(rec2.id)!.rows[0].status, "pending");
});

test("broadcast ledger survives a fresh read (daemon restart): status still rolls up", () => {
  _resetLedgerCache();
  const rec = createBroadcast({ senderId: BC_SENDER, senderName: "Sender", message: "freeze workers soon", ask: false, defaultOk: false, recipients: [{ sessionId: BC_ANSWERER, name: "Answerer" }] });
  drainSessionMailbox(BC_ANSWERER);
  _resetLedgerCache();
  const s = getBroadcastStatus(rec.id)!;
  assert.equal(s.message, "freeze workers soon");
  assert.equal(s.rows[0].status, "silent", "a non-ask has nothing to roll up but silence");
});

test("broadcast handler fan-out: every live claude session except the sender, shells skipped", () => withStubLock(async () => {
  _resetLedgerCache();
  await privateStub(baseRows());
  const handlers = registerAndCapture();
    const r = (await handlers.get("broadcast")!(req({ itermSessionId: BC_SENDER, params: { message: SHOUT } }))) as any;
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.result.deliveredTo, 2, "answerer + bystander, not the sender and not the shell");

    const forAnswerer = drainSessionMailbox(BC_ANSWERER);
    assert.equal(forAnswerer.length, 1);
    assert.match(forAnswerer[0].content, /^\[Broadcast:bc-sender-pane\] /);
    assert.match(drainSessionMailbox("bc-bystander-pane")[0].content, /^\[Broadcast:bc-sender-pane\] /);
    assert.deepEqual(drainSessionMailbox("bc-shell-tab"), [], "nothing is ever deposited into a shell");
    assert.deepEqual(drainSessionMailbox(BC_SENDER), [], "the sender does not receive its own shout");

    // Ledgered: the broadcast id resolves to its roll-call.
    assert.equal(getBroadcastStatus(r.result.id)!.rows.length, 2);
}));

test("broadcast handler ask round-trip: reply recorded, status shows ok/hold vs silent after the deadline", () => withStubLock(async () => {
  _resetLedgerCache();
  await privateStub(baseRows());
  const handlers = registerAndCapture();
    const b = (await handlers.get("broadcast")!(req({ itermSessionId: BC_SENDER, params: { message: SHOUT, ask: true, deadline: "2m" } }))) as any;
    assert.equal(b.result.ask, true);
    // The delivery report names its recipients — the CLI prints this list.
    assert.deepEqual(b.result.recipients.map((r: any) => r.sessionId).sort(), [BC_ANSWERER, "bc-bystander-pane"]);
    // The ask carries its id and the exact reply command.
    assert.match(drainSessionMailbox(BC_ANSWERER)[0].content, new RegExp(`broadcast reply ${b.result.id} ok\\|hold`));

    const rep = (await handlers.get("broadcast_reply")!(req({ itermSessionId: BC_ANSWERER, params: { broadcastId: b.result.id, answer: "ok" } }))) as any;
    assert.equal(rep.ok, true, JSON.stringify(rep));
    // Not the last answer outstanding → no summary yet, and never one message
    // per reply. The sender's mailbox stays quiet until all answered/deadline.
    assert.deepEqual(drainSessionMailbox(BC_SENDER), []);

    // A stranger that never received it may not answer.
    const bogus = (await handlers.get("broadcast_reply")!(req({ itermSessionId: "bc-shell-tab", params: { broadcastId: b.result.id, answer: "ok" } }))) as any;
    assert.equal(bogus.ok, false);

    const rep2 = (await handlers.get("broadcast_reply")!(req({ itermSessionId: "bc-bystander-pane", params: { broadcastId: b.result.id, answer: "hold", reason: "mid-deploy" } }))) as any;
    assert.equal(rep2.ok, true);

    // The last answer outstanding landed → the handler fires ONE summary into
    // the sender's mailbox (not one message per reply).
    const summaries = drainSessionMailbox(BC_SENDER);
    assert.equal(summaries.length, 1, `exactly one summary line, got ${summaries.length}`);
    assert.match(summaries[0].content, new RegExp(`\\[Broadcast-summary:${b.result.id}\\] 2/2 answered \\(all answered\\)`));

    const st = (await handlers.get("broadcast_rollcall")!(req({ params: { broadcastId: b.result.id } }))) as any;
    assert.equal(st.ok, true);
    // Deadline not yet passed: the answered ones read their answers.
    const byName = new Map<string, string>(st.result.rows.map((row: any) => [row.sessionId, row.status]));
    assert.equal(byName.get("bc-answerer-pane"), "ok");
    assert.equal(byName.get("bc-bystander-pane"), "hold");
    // The summary fired once; a later status read must not re-notify.
    drainSessionMailbox(BC_SENDER);
    await handlers.get("broadcast_rollcall")!(req({ params: { broadcastId: b.result.id } }));
    assert.deepEqual(drainSessionMailbox(BC_SENDER), [], "the summary is sent at most once");

    // A default-ok broadcast whose deadline has passed: silence is no objection.
    const b2 = (await handlers.get("broadcast")!(req({ itermSessionId: BC_SENDER, params: { message: "restart in 5", ask: true, deadline: 1, defaultOk: true } }))) as any;
    // The reply handler itself fires the summary once the roll-call is
    // complete — and that is what this asserts, through the real handler.
    // Answered BY the answerer (a stranger's id would be refused). NOTE: in
    // THIS fixture the sender resolves to "unknown-session" (the bare req()),
    // not BC_SENDER — so the summary lands under the sender's own key, which
    // is exactly what notifyBroadcastSummary deposits to (senderId + its parts).
    const rep_b2 = (await handlers.get("broadcast_reply")!(req({ itermSessionId: BC_ANSWERER, params: { broadcastId: b2.result.id, answer: "ok" } }))) as any;
    assert.equal(rep_b2.ok, true);
    // One of two answered is nothing to report yet — the sender's mailbox (the
    // sender's recorded pane key) stays empty.
    assert.deepEqual(drainSessionMailbox(BC_SENDER), [], "no summary before all answered");

    // The SECOND answer completes the roll-call: the handler fires the ONE
    // summary line into the sender's mailbox then, and only then.
    const rep_b2b = (await handlers.get("broadcast_reply")!(req({ itermSessionId: "bc-bystander-pane", params: { broadcastId: b2.result.id, answer: "ok" } }))) as any;
    assert.equal(rep_b2b.ok, true);
    const s2 = drainSessionMailbox(BC_SENDER);
    assert.equal(s2.length, 1, `one summary for the completed ask, got ${s2.length}`);
    assert.match(s2[0].content, new RegExp(`\\[Broadcast-summary:${b2.result.id}\\] 2/2 answered \\(all answered\\): 2 ok`));
    const late2 = getBroadcastStatus(b2.result.id, Date.now() + 10_000)!;
    const by2 = new Map<string, string>(late2.rows.map((row) => [row.sessionId, row.status]));
    assert.equal(by2.get("bc-answerer-pane"), "ok");
    // The second answer completed the roll-call before the deadline — both
    // read their answers; defaultOk only labels silence.
    assert.equal(by2.get("bc-bystander-pane"), "ok");

    // A default-ok ask whose deadline passes UNANSWERED reads no-objection:
    // b3 below covers that (its bystander never answers).

    // Same clock WITHOUT defaultOk: the unanswered one is silent.
    const b3 = (await handlers.get("broadcast")!(req({ itermSessionId: BC_SENDER, params: { message: "restart in 5", ask: true, deadline: 1 } }))) as any;
    recordBroadcastReply(b3.result.id, BC_ANSWERER, "bc-answerer-pane", "ok", undefined);
    drainSessionMailbox(BC_SENDER); // b3's summary (all answered) — not what this asserts
    const late3 = getBroadcastStatus(b3.result.id, Date.now() + 10_000)!;
    assert.equal(new Map(late3.rows.map((row) => [row.sessionId, row.status])).get("bc-bystander-pane"), "silent");

    // A shout with nobody to reach is refused WITH a reason — never a silent
    // "delivered to 0". The fixture: only the sender's own pane remains (the
    // answerer and bystander are gone, the shell is never asked).
    await privateStub([[BC_SENDER, "claude (node)", "/dev/ttys901", "◑ Sender (claude)", "", ""]]);
    const alone = await handlers.get("broadcast")!(req({ itermSessionId: BC_SENDER, params: { message: "anyone there?" } }));
    assert.equal(alone.ok, false);
    assert.match((alone as any).error, /no other live Claude session/);
}));

// ── the summary line: one per ask, at all-answered or the deadline ─────────

test("broadcast summary: not before all answered; one line when all answered; never twice", () => {
  _resetLedgerCache();
  const rec = createBroadcast({
    senderId: BC_SENDER, senderName: "Sender", message: "restart window?", ask: true, deadlineSec: 120, defaultOk: false,
    recipients: [{ sessionId: "bc-sum-a", name: "A" }, { sessionId: "bc-sum-b", name: "B" }],
  });
  drainSessionMailbox("bc-sum-a"); drainSessionMailbox("bc-sum-b");

  recordBroadcastReply(rec.id, "bc-sum-a", "A", "ok", undefined);
  assert.equal(summaryDueAt(getBroadcastStatus(rec.id)!.record, Date.now()), undefined, "one of two answered is nothing to report");
  assert.deepEqual(drainSessionMailbox(BC_SENDER), []);

  recordBroadcastReply(rec.id, "bc-sum-b", "B", "hold", "mid-deploy");
  const b = getBroadcastStatus(rec.id)!.record;
  assert.equal(summaryDueAt(b, Date.now()) !== undefined, true);
  assert.equal(notifyBroadcastSummary(b), true);
  const m = drainSessionMailbox(BC_SENDER);
  assert.equal(m.length, 1);
  assert.match(m[0].content, /\[Broadcast-summary:/);
  assert.match(m[0].content, /2\/2 answered \(all answered\): 1 ok, 1 hold/);
  assert.match(m[0].content, /hold: B — mid-deploy/);
  assert.equal(notifyBroadcastSummary(getBroadcastStatus(rec.id)!.record), false, "at most once");
  assert.deepEqual(drainSessionMailbox(BC_SENDER), []);
});

test("broadcast summary at the deadline: silence reports as silent/no-objection; durable across a restart", () => {
  _resetLedgerCache();
  const rec = createBroadcast({
    senderId: BC_SENDER, senderName: "Sender", message: "freeze soon?", ask: true, deadlineSec: 60, defaultOk: false,
    recipients: [{ sessionId: "bc-sum-c", name: "C" }],
  });
  drainSessionMailbox("bc-sum-c");
  const late = Date.now() + 120_000;
  assert.equal(summaryDueAt(getBroadcastStatus(rec.id)!.record, late) !== undefined, true);
  assert.equal(notifyBroadcastSummary(getBroadcastStatus(rec.id)!.record, late), true);
  const m = drainSessionMailbox(BC_SENDER);
  // Nothing answered → "0/1", the tally reads silent.
  assert.match(m[0].content, /0\/1 answered \(deadline passed\): 1 silent/);

  // The notified flag is in the ledger file: a fresh read (daemon restart)
  // must not re-notify.
  _resetLedgerCache();
  assert.equal(notifyBroadcastSummary(getBroadcastStatus(rec.id)!.record, late + 1000), false);
  assert.deepEqual(drainSessionMailbox(BC_SENDER), []);

  // defaultOk flips the wording of silence in the summary too.
  const rec2 = createBroadcast({
    senderId: BC_SENDER, senderName: "Sender", message: "ok to restart?", ask: true, deadlineSec: 60, defaultOk: true,
    recipients: [{ sessionId: "bc-sum-d", name: "D" }],
  });
  drainSessionMailbox("bc-sum-d");
  assert.match(composeSummaryText(getBroadcastStatus(rec2.id)!.record, late), /1 no-objection/);
});

// ── the CLI's own words: id + recipients + delivered; ledger-backed status ──

test("broadcast CLI: prints the id, every recipient and 'delivered to N'; a refusal names its reason", async () => {
  const lines: string[] = [];
  const errs: string[] = [];
  const origError = console.error;
  console.error = (l: unknown) => errs.push(String(l));
  try {
    const code = await broadcastCli(["hello", "--ask", "--deadline", "10m"], {
      call: async (method, params) => {
        assert.equal(method, "broadcast");
        assert.equal(params.deadline, "10m");
        return { id: "abc23", deliveredTo: 2, skippedShells: 1, recipients: [{ sessionId: "p1", name: "One" }, { sessionId: "p2", name: "Two" }] };
      },
      readStdin: async () => "",
      out: (l) => lines.push(l),
    });
    assert.equal(code, 0);
    assert.match(lines[0], /^Broadcast abc23 delivered to 2 session\(s\), 1 shell tab\(s\) skipped\./);
    assert.deepEqual(lines.slice(1, 3), ["  → One", "  → Two"]);
    assert.match(lines[3], /deadline 10m.*broadcast status abc23/);

    // A refusal arrives as a thrown error carrying the reason (client
    // contract). Fresh `lines` — a refusal must add no delivery line.
    lines.length = 0;
    const refused = await broadcastCli(["hello"], {
      call: async () => { throw new Error("nothing was sent — no other live Claude session to reach"); },
      readStdin: async () => "", out: (l) => lines.push(l),
    });
    assert.equal(refused, 1);
    assert.match(errs.at(-1)!, /refused: nothing was sent/);
    assert.deepEqual(lines, [], "a refusal prints no delivery line");
  } finally { console.error = origError; }
});

test("broadcast CLI status: survives a daemon that cannot answer the roll-call — reads the durable ledger", async () => {
  _resetLedgerCache();
  const rec = createBroadcast({
    senderId: BC_SENDER, senderName: "Sender", message: "old daemon test", ask: true, deadlineSec: 60, defaultOk: false,
    recipients: [{ sessionId: "bc-cli-a", name: "A" }, { sessionId: "bc-cli-b", name: "B" }],
  });
  drainSessionMailbox("bc-cli-a"); drainSessionMailbox("bc-cli-b");
  recordBroadcastReply(rec.id, "bc-cli-a", "A", "ok", undefined);

  const lines: string[] = [];
  // The old-daemon fault (live 2026-11-18): the call throws — status must
  // still roll up from broadcasts.json on disk.
  const code = await broadcastCli(["status", rec.id], {
    call: async () => { throw new Error("Unknown method: broadcast_rollcall"); },
    readStdin: async () => "", out: (l) => lines.push(l),
  });
  assert.equal(code, 0);
  assert.match(lines[0], new RegExp(`broadcast ${rec.id} from Sender: old daemon test`));
  assert.match(lines[0], /deadline .*T.*Z/);
  assert.match(lines[1], /1 ok, 1 pending/);
  assert.match(lines.join("\n"), /ok\s+A\n\s*pending\s+B/);

  // An id the ledger does not know stays an error — the fallback must not
  // invent a roll-call.
  const missing = await broadcastCli(["status", "zzzzz"], {
    call: async () => { throw new Error("Unknown method"); },
    readStdin: async () => "", out: () => {},
  });
  assert.equal(missing, 1);
});
