import "./home-guard.js";
/**
 * test/watcher-client-worker-identity.test.ts — a worker must not claim the
 * pane owner's identity.
 *
 * WatcherClient.sessionId used to be process.env.TERM_SESSION_ID verbatim.
 * A worker child process (`pai worker run`, PAI_WORKER=1) inherits that
 * along with ITERM_SESSION_ID/TMUX_PANE from the pane it was spawned in, so
 * every IPC call it made carried the PANE OWNER's own identity — recorded
 * live as audit actor "session:AIBroker" for test sends made by a worker
 * running inside the orchestrator's pane (ab-mudszmy4, ab-mudt0v7g,
 * ab-mudt7cn8). callerItermId() falls back to req.sessionId when
 * itermSessionId is absent, so this field alone is enough to impersonate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { WatcherClient } from "../src/ipc/client.js";

const ORIGINAL_ENV = { ...process.env };
function restoreEnv() {
  for (const k of Object.keys(process.env)) if (!(k in ORIGINAL_ENV)) delete process.env[k];
  Object.assign(process.env, ORIGINAL_ENV);
}

test("PAI_WORKER=1: session id is a fabricated marker, not the inherited pane id", () => {
  try {
    process.env.PAI_WORKER = "1";
    process.env.TERM_SESSION_ID = "w0t0p0:00000000-0000-0000-0000-000000000000"; // the "pane owner"
    const client = new WatcherClient("/tmp/aibroker-test-unused.sock");
    assert.notEqual(client.session, process.env.TERM_SESSION_ID);
    assert.match(client.session, /^worker-\d+$/, "distinct, pid-scoped, and never colon-shaped (see callerItermId's colon-split)");
  } finally {
    restoreEnv();
  }
});

test("without PAI_WORKER: unchanged — TERM_SESSION_ID is the session id", () => {
  try {
    delete process.env.PAI_WORKER;
    process.env.TERM_SESSION_ID = "w0t0p0:00000000-0000-0000-0000-000000000000";
    const client = new WatcherClient("/tmp/aibroker-test-unused.sock");
    assert.equal(client.session, process.env.TERM_SESSION_ID);
  } finally {
    restoreEnv();
  }
});
