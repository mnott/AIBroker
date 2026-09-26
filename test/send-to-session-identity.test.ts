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
const { _internal, invalidateSnapshotCache } = await import("../src/adapters/iterm/core.js");
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

function req(fields: Partial<IpcRequest>): IpcRequest {
  return { id: "r1", sessionId: "unknown-session", method: "send_to_session", params: {}, ...fields } as IpcRequest;
}

// ── A: a failed enumeration must retry, then queue — never "not found" ─────

test("A: an unreliable/empty enumeration retries and then queues by the persisted name, not \"not found\"", async () => {
  setPersistentSessionName("session-live-1", "AIBroker");
  invalidateSnapshotCache();
  const original = _internal.runAppleScript;
  // Every enumeration in this test fails — retries never see a live session.
  _internal.runAppleScript = () => null;
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
    _internal.runAppleScript = original;
    invalidateSnapshotCache();
  }
});

test("A: a RELIABLE enumeration that genuinely has no match still reports \"not found\"", async () => {
  // The fix must not paper over a real absence — only an unreliable answer.
  invalidateSnapshotCache();
  const original = _internal.runAppleScript;
  _internal.runAppleScript = () => APPLESCRIPT_ONE_LIVE_SESSION; // answers, just has nobody named this
  try {
    const handlers = registerAndCapture();
    const send = handlers.get("send_to_session")!;
    const r = await send(req({ params: { target: "NoSuchSession", message: "hello" } }));
    assert.equal(r.ok, false);
    assert.match((r as { ok: false; error: string }).error, /not found/);
  } finally {
    _internal.runAppleScript = original;
    invalidateSnapshotCache();
  }
});

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
