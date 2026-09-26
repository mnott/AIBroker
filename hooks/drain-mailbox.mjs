#!/usr/bin/env node
/**
 * hooks/drain-mailbox.mjs — deliver what the mailbox is holding.
 *
 * `send_to_session` deposits into the target's mailbox and types a copy into
 * its terminal. The typed copy is best-effort — a session mid-turn never reads
 * it — and the mailbox was pull-only, so a message only arrived if the session
 * happened to call `aibroker_receive`. It usually did not: 35 real messages
 * across five sessions sat undrained on 2026-08-01/02, the oldest for a day.
 *
 * A UserPromptSubmit hook is the natural drain. It runs before the model sees
 * the turn, which is the first moment a busy session is listening again, so
 * anything queued is injected as context on the very next turn rather than
 * whenever someone thinks to check.
 *
 * Delivery is two-phase for the same reason: a destructive read here lost a
 * message live on 2026-09-25 (daemon drained, hook's 1.5 s reply timeout
 * fired, nothing emitted). So this hook PEEKS (non-destructive), emits, and
 * only then ACKs the daemon to clear. Any timeout along the way leaves the
 * messages queued for the next prompt — a duplicate redelivery, never a loss.
 * If the output cannot be emitted at all, the messages are additionally
 * written to ~/.aibroker/undelivered.jsonl rather than lost, which is the
 * whole failure this hook exists to end.
 *
 * Silent when there is nothing waiting, and silent on every error: a hook that
 * fails loudly on every prompt is a hook someone disables.
 */

import net from "node:net";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// AIBROKER_HOOK_SOCKET is a test seam: it lets tests point the hook at a fake
// daemon socket instead of the live one. Production never sets it.
const SOCKET = process.env.AIBROKER_HOOK_SOCKET ?? "/tmp/aibroker.sock";
const TIMEOUT_MS = 1500;
const UNDELIVERED = join(homedir(), ".aibroker", "undelivered.jsonl");

/** The session this hook is running inside. Without it there is nothing to drain. */
function sessionId() {
  const raw = process.env.TMUX_PANE ?? process.env.ITERM_SESSION_ID;
  if (!raw) return undefined;
  return raw.includes(":") ? raw.split(":").pop() : raw;
}

function call(method, params) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const timer = setTimeout(() => { try { sock.destroy(); } catch {} finish(null); }, TIMEOUT_MS);
    const sock = net.createConnection(SOCKET, () => {
      sock.write(JSON.stringify({ id: "drain", method, params }) + "\n");
    });
    let buf = "";
    sock.on("data", (d) => {
      buf += d;
      if (!buf.includes("\n")) return;
      clearTimeout(timer);
      try { finish(JSON.parse(buf.trim())); } catch { finish(null); }
      sock.end();
    });
    // The daemon being down is not this hook's problem to report.
    sock.on("error", () => { clearTimeout(timer); finish(null); });
  });
}

// A worker child process (PAI_WORKER=1) inherits TERM_SESSION_ID/
// ITERM_SESSION_ID/TMUX_PANE from the pane it runs inside, so sessionId()
// below would resolve to the pane OWNER's id, not its own — draining is
// destructive, so this would empty the owner's real mailbox on the worker's
// own prompts before the owner ever saw the messages in it. Observed live
// 2026-09-23: a worker's reply to "AIBroker" was recorded as delivered but
// never surfaced in the real AIBroker session, and aibroker_receive there
// found nothing.
if (process.env.PAI_WORKER === "1") process.exit(0);

const id = sessionId();
if (!id) process.exit(0);

// Phase 1: peek, non-destructive. A timeout here emits nothing and the
// messages stay queued — delivered on the next prompt instead of lost.
const res = await call("session_mailbox_peek", { sessionId: id });
const messages = res?.ok ? (res.result?.messages ?? []) : [];
if (messages.length === 0) process.exit(0);

const lines = messages.map((m) => {
  // Local, not UTC. The reader compares this against `date`, the manager's
  // status and a forge's own timestamps, all of which are local — an hour
  // printed in a different zone reads as a delay that did not happen, and the
  // reader does the arithmetic without knowing they should.
  const when = m.timestamp ? new Date(m.timestamp).toLocaleTimeString("en-GB", { hour12: false }) : "";
  const waited = m.timestamp ? Math.round((Date.now() - m.timestamp) / 60000) : null;
  const age = waited !== null && waited >= 1 ? ` (waited ${waited} min)` : "";
  return `[Session:${m.from}] ${when}${age}\n${m.content}`;
});

const out =
  `<system-reminder>\n` +
  `${messages.length} message(s) were waiting in this session's mailbox and have been delivered now.\n` +
  `They arrived while this session was busy. Treat each as if it had just been sent: reply to the\n` +
  `sender with aibroker_send_to_session, not in the terminal.\n\n` +
  lines.join("\n\n") +
  `\n</system-reminder>`;

let emitted = true;
try {
  process.stdout.write(out + "\n");
} catch (e) {
  emitted = false;
  // The mailbox is NOT cleared on a peek, so the messages stay queued — but a
  // queue nobody drains is undelivered, not pending, so they are recorded here
  // too. Losing them would be the exact silent drop this hook was written to stop.
  try {
    mkdirSync(join(homedir(), ".aibroker"), { recursive: true });
    appendFileSync(UNDELIVERED, messages.map((m) => JSON.stringify({ ...m, failedAt: new Date().toISOString(), error: String(e) })).join("\n") + "\n");
  } catch { /* nothing left to try */ }
}

// Phase 2, only after a successful emit: ack the daemon to clear what was
// peeked. Best-effort — a timeout here leaves the messages queued and they are
// re-delivered on the next prompt. A duplicate is acceptable; a loss is not.
if (emitted) await call("session_mailbox_ack", { sessionId: id, count: messages.length });
