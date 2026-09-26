import "./home-guard.js";
/**
 * test/caller-iterm-id.test.ts — the sender's name, when only one field carries it.
 *
 * The bug this pins: two request fields hold the caller's iTerm2 session, and
 * callers do not agree on which to fill. The resolution asked `itermSessionId`
 * alone, so when a caller filled `sessionId` instead the lookup never ran and
 * the RAW composite id went out where the sender's name belongs. A message
 * between sessions arrived at PAI on 2026-08-24 labelled
 *
 *     [Session:w11t0p0:066504E1-...]
 *
 * and the `w11t0p0:` is the proof of which branch produced it: the
 * normalisation strips that prefix, so it could only have come from the
 * fallback that prints the untouched field.
 *
 * Why it is worth a test rather than a fix and a shrug. That label is the
 * receiver's only evidence of who sent a message, and it is also the address
 * they are told to answer — and the reply tool takes a name or an index, not a
 * GUID. The message that arrived that way was relaying the operator's own
 * instruction, so it was both unattributable and unanswerable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { callerItermId, sendToSessionDelivery } from "../src/daemon/core-handlers.js";
import type { IpcRequest } from "../src/types/ipc.js";

const UUID = "066504E1-BB16-48D3-9A74-C1F8BA45B7F3";

/** Just enough of a request for the resolver; the rest is not consulted. */
function req(fields: Partial<IpcRequest>): IpcRequest {
  return { method: "send_to_session", params: {}, ...fields } as IpcRequest;
}

test("takes the uuid out of iTerm's window/tab/pane form", () => {
  assert.equal(callerItermId(req({ itermSessionId: `w0t0p0:${UUID}` })), UUID);
});

test("a bare uuid is already the answer", () => {
  assert.equal(callerItermId(req({ itermSessionId: UUID })), UUID);
});

test("falls back to sessionId — the case that shipped a GUID as a name", () => {
  // No itermSessionId at all. Before the fix this returned undefined, the
  // snapshot was never searched, and `w11t0p0:UUID` was printed verbatim.
  assert.equal(callerItermId(req({ sessionId: `w11t0p0:${UUID}` })), UUID);
});

test("both fields present: itermSessionId is the more specific one and wins", () => {
  const other = "AD45835E-7F1E-40B6-B590-9C466F7A9B25";
  assert.equal(
    callerItermId(req({ itermSessionId: `w0t0p0:${other}`, sessionId: `w11t0p0:${UUID}` })),
    other,
  );
});

test("neither field: undefined, so the caller can say \"unknown\" rather than guess", () => {
  assert.equal(callerItermId(req({})), undefined);
});

// ── sendToSessionDelivery — a beat is typed bare and never mailed ───────────
//
// The bug this pins: an idle cache-keepalive beat went through send_to_session
// like any other message, so it always picked up a `[Session:...]` prefix —
// telling the receiving Claude to reply to it — and a mailbox copy, so the
// drain-mailbox reminder repeated that demand. Idle sessions spent a turn and
// a tool call answering a beat, and the acks landed in unrelated sessions
// because the sender label was not a registered session at all.

test("noReply: typed bare, no [Session:] prefix, and nothing is deposited", () => {
  const r = sendToSessionDelivery("beat", "cache-keepalive", true);
  assert.equal(r.typed, "beat");
  assert.equal(r.deposit, false);
});

test("default (noReply absent/false): a one-line pointer is typed, not the body — deposited", () => {
  // The bug this pins: typing the full body AND depositing it means the
  // target's drain-mailbox UserPromptSubmit hook fires on that very
  // submission and re-shows the same content a second time in one turn.
  // Reproduced live 2026-09-23. The pointer must never contain the message
  // body, or a long/multi-line body defeats the fix by leaking back in.
  const r = sendToSessionDelivery("run the sweep", "PAI", false);
  assert.ok(r.typed.startsWith("[Session:PAI]"));
  assert.ok(!r.typed.includes("run the sweep"), "typed text must not repeat the body");
  assert.equal(r.typed.split("\n").length, 1, "typed text must be a single line");
  assert.equal(r.deposit, true);
});

test("an 8-line AG2 body: typed stays one line, nothing to lose a head from", () => {
  // FAULT 4 (2026-09-23): an 8-line message to a busy target was reported to
  // arrive with only its last line. Typing a multi-line body into a busy
  // pane was never actually observed dropping lines in live testing here —
  // but this call no longer types the body at all, so there is nothing left
  // for that failure mode to act on regardless of pane or busy state.
  const body = Array.from({ length: 8 }, (_, i) => `line${i + 1} of 8`).join("\n");
  const r = sendToSessionDelivery(body, "PAI", false);
  assert.equal(r.typed.split("\n").length, 1);
  assert.ok(!r.typed.includes("line8 of 8"));
  assert.equal(r.deposit, true);
});
