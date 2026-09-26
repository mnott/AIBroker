import "./home-guard.js";
/**
 * test/mailbox-peek-ack.test.ts — the two-phase mailbox drain cannot lose a
 * message.
 *
 * hooks/drain-mailbox.mjs used `session_mailbox_receive`, a destructive read
 * with a 1.5 s client timeout. If the daemon was slow to reply, the
 * daemon-side drain had already emptied the mailbox while the hook printed
 * nothing — a silent drop (live 2026-09-25: message from PAI to AIBroker
 * recorded "delivered", receiver never saw it).
 *
 * The fix splits the drain: session_mailbox_peek (read, no clear) → hook
 * emits → session_mailbox_ack (clear what was peeked). A timeout at ANY phase
 * leaves the messages queued for redelivery — a duplicate is acceptable, a
 * loss is not.
 *
 * Part 1 tests the daemon handlers through the registerAndCapture seam
 * (see send-to-session-identity.test.ts). Part 2 drives the real hook against
 * a fake daemon socket (via the AIBROKER_HOOK_SOCKET test seam) to prove the
 * timeout paths.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = join(__dirname, "..", "hooks", "drain-mailbox.mjs");

// core-handlers pulls in modules that resolve ~/.aibroker at import time —
// redirect before anything under src/ is imported.
const scratch = mkdtempSync(join(tmpdir(), "aibroker-peek-ack-"));
process.env.HOME = scratch;
mkdirSync(join(scratch, ".aibroker"), { recursive: true });

const { registerCoreHandlers } = await import("../src/daemon/core-handlers.js");
const { depositToSessionMailbox, drainSessionMailbox } = await import("../src/core/state.js");
import type { IpcRequest } from "../src/types/ipc.js";
import type { IpcHandler } from "../src/ipc/server.js";

function registerAndCapture(): Map<string, IpcHandler> {
  const handlers = new Map<string, IpcHandler>();
  const fakeServer = { on: (method: string, handler: IpcHandler) => handlers.set(method, handler) };
  registerCoreHandlers(fakeServer as any, {} as any, {} as any, {} as any);
  return handlers;
}

function req(fields: Partial<IpcRequest>): IpcRequest {
  return { id: "r1", sessionId: "unknown-session", method: "session_mailbox_peek", params: {}, ...fields } as IpcRequest;
}

function messagesOf(r: unknown): { from: string; content: string }[] {
  assert.equal((r as { ok: boolean }).ok, true);
  return ((r as { result: { messages: { from: string; content: string }[] } }).result.messages);
}

// ── Part 1: daemon handler semantics ────────────────────────────────────────

test("peek returns messages WITHOUT clearing — a second peek still returns them", async () => {
  drainSessionMailbox("peek-1");
  const handlers = registerAndCapture();
  depositToSessionMailbox("peek-1", "PAI", "first");
  depositToSessionMailbox("peek-1", "Telex", "second");

  const peek = handlers.get("session_mailbox_peek")!;
  assert.equal(messagesOf(await peek(req({ params: { sessionId: "peek-1" } }))).length, 2);
  assert.equal(messagesOf(await peek(req({ params: { sessionId: "peek-1" } }))).length, 2, "peek must not clear the queue");
});

test("env-var id form \"w0t0p1:UUID\" normalizes to the bare UUID for peek and ack", async () => {
  drainSessionMailbox("peek-norm");
  const handlers = registerAndCapture();
  depositToSessionMailbox("peek-norm", "PAI", "hello");

  const peekR = await handlers.get("session_mailbox_peek")!(req({ params: { sessionId: "w0t0p1:peek-norm" } }));
  assert.equal((peekR as { result: { sessionId: string } }).result.sessionId, "peek-norm");
  assert.equal(messagesOf(peekR).length, 1);

  const ackR = await handlers.get("session_mailbox_ack")!(req({ params: { sessionId: "w0t0p1:peek-norm", count: 1 } }));
  assert.equal((ackR as { result: { cleared: number } }).result.cleared, 1);
  assert.equal(messagesOf(await handlers.get("session_mailbox_peek")!(req({ params: { sessionId: "peek-norm" } }))).length, 0);
});

test("ack clears; peek after ack returns empty", async () => {
  drainSessionMailbox("ack-1");
  const handlers = registerAndCapture();
  depositToSessionMailbox("ack-1", "PAI", "first");
  depositToSessionMailbox("ack-1", "PAI", "second");

  const ackR = await handlers.get("session_mailbox_ack")!(req({ params: { sessionId: "ack-1", count: 2 } }));
  assert.equal((ackR as { result: { cleared: number } }).result.cleared, 2);
  assert.equal(messagesOf(await handlers.get("session_mailbox_peek")!(req({ params: { sessionId: "ack-1" } }))).length, 0);
});

test("ack with count spares a message deposited after the peek — no interleave loss", async () => {
  drainSessionMailbox("ack-race");
  const handlers = registerAndCapture();
  depositToSessionMailbox("ack-race", "PAI", "seen by the peek");
  await handlers.get("session_mailbox_peek")!(req({ params: { sessionId: "ack-race" } }));
  // Arrives between the peek and its ack — must survive the ack.
  depositToSessionMailbox("ack-race", "Telex", "deposited after the peek");

  const ackR = await handlers.get("session_mailbox_ack")!(req({ params: { sessionId: "ack-race", count: 1 } }));
  assert.equal((ackR as { result: { cleared: number } }).result.cleared, 1);
  const left = messagesOf(await handlers.get("session_mailbox_peek")!(req({ params: { sessionId: "ack-race" } })));
  assert.equal(left.length, 1);
  assert.equal(left[0].content, "deposited after the peek");
});

test("receive still clears in one call (unchanged destructive semantics for interactive callers)", async () => {
  drainSessionMailbox("recv-1");
  const handlers = registerAndCapture();
  depositToSessionMailbox("recv-1", "PAI", "first");
  depositToSessionMailbox("recv-1", "PAI", "second");

  const r = await handlers.get("session_mailbox_receive")!(req({ method: "session_mailbox_receive", params: { sessionId: "recv-1" } }));
  assert.equal(messagesOf(r).length, 2);
  assert.equal(messagesOf(await handlers.get("session_mailbox_peek")!(req({ params: { sessionId: "recv-1" } }))).length, 0);
});

test("no session id: peek and ack fail exactly like receive", async () => {
  const handlers = registerAndCapture();
  for (const method of ["session_mailbox_peek", "session_mailbox_ack", "session_mailbox_receive"]) {
    const r = await handlers.get(method)!(req({ method, sessionId: undefined, itermSessionId: undefined, params: {} }));
    assert.equal((r as { ok: boolean }).ok, false, method);
    assert.match((r as { error: string }).error, /Cannot determine session ID/);
  }
});

// ── Part 2: the real hook against a fake daemon socket ─────────────────────

/** Fake daemon: answers peek (unless mode "peek-silent"), never answers ack. */
function fakeDaemon(socketPath: string, mode: "ack-silent" | "peek-silent") {
  const seen: Array<{ method: string; params: Record<string, unknown> }> = [];
  const server = net.createServer((sock) => {
    let buf = "";
    sock.on("data", (d) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg: { id: string; method: string; params?: Record<string, unknown> };
        try { msg = JSON.parse(line); } catch { continue; }
        seen.push({ method: msg.method, params: msg.params ?? {} });
        if (msg.method === "session_mailbox_peek" && mode !== "peek-silent") {
          sock.write(JSON.stringify({
            id: msg.id, ok: true,
            result: { sessionId: "hook-test", messages: [{ from: "PAI", content: "the reply that must survive a slow ack", timestamp: Date.now() }] },
          }) + "\n");
        }
        // session_mailbox_ack: deliberately never answered in either mode.
      }
    });
  });
  return {
    seen,
    listen: () => new Promise<void>((res) => server.listen(socketPath, res)),
    close: () => new Promise<void>((res) => server.close(() => res())),
  };
}

/**
 * Spawn the hook WITHOUT blocking this process's event loop: the fake daemon
 * lives in here too, and a spawnSync parent cannot accept() its connection,
 * so the hook's peek would time out against a server that is right here.
 */
function runHook(socketPath: string): Promise<{ status: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn("node", [HOOK], {
      env: { ...process.env, PAI_WORKER: "", ITERM_SESSION_ID: "w0t0p1:hook-test", AIBROKER_HOOK_SOCKET: socketPath },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const killTimer = setTimeout(() => p.kill("SIGKILL"), 10000);
    let stdout = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.on("error", reject);
    p.on("close", (status) => { clearTimeout(killTimer); resolve({ status, stdout }); });
  });
}

test("hook: ack timeout cannot lose a message — content emitted, ack still attempted", async () => {
  const socketPath = join(scratch, "ack-silent.sock");
  const daemon = fakeDaemon(socketPath, "ack-silent");
  await daemon.listen();
  try {
    const r = await runHook(socketPath);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /\[Session:PAI\]/, "the message content must be emitted even though ack never got a reply");
    assert.match(r.stdout, /the reply that must survive a slow ack/);
    assert.match(r.stdout, /1 message\(s\) were waiting/);
    // The ack was attempted with the peeked count. In the real daemon an ack
    // that never processes clears nothing (peek is non-destructive — Part 1),
    // so the message re-delivers on the next prompt. Duplicate, not loss.
    const ack = daemon.seen.find((m) => m.method === "session_mailbox_ack");
    assert.ok(ack, "hook must still attempt the ack after emitting");
    assert.equal(ack!.params.count, 1);
  } finally {
    await daemon.close();
  }
});

test("hook: peek timeout emits nothing and never reaches the ack — messages stay queued server-side", async () => {
  const socketPath = join(scratch, "peek-silent.sock");
  const daemon = fakeDaemon(socketPath, "peek-silent");
  await daemon.listen();
  try {
    const r = await runHook(socketPath);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), "", "a timed-out peek must emit nothing");
    // The old bug's shape: timeout + no output. Harmless now — nothing was
    // cleared, the next prompt peeks the same messages again.
    assert.equal(daemon.seen.find((m) => m.method === "session_mailbox_ack"), undefined, "no ack without a successful peek+emit");
  } finally {
    await daemon.close();
  }
});
