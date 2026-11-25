import "./home-guard.js";
/**
 * test/voice-handlers.test.ts — session-scoped voice over the hub socket.
 *
 * "reply in voice, slower" must change only the caller's own entry and leave
 * the global config alone; a named target must resolve through the same matcher
 * every other verb uses; speak must honour explicit > session > global for both
 * voice and speed, and queue instead of blocking on synthesis.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "aibroker-voice-handlers-"));
process.env.HOME = scratch;
mkdirSync(join(scratch, ".aibroker"), { recursive: true });

let enqueued: { session: string; text: string; voice?: string; speed?: number }[] = [];
let replayResult = false;

// The real playback module is being built by another worker; the handlers reach
// it through a lazy dynamic import, which mock.module hooks.
mock.module("../src/adapters/kokoro/playback.js", {
  namedExports: {
    enqueueSpeech: (job: { session: string; text: string; voice?: string; speed?: number }) => { enqueued.push(job); return { queued: 1 }; },
    stopPlayback: () => ({ stopped: true, cleared: 2 }),
    replayLast: (_session: string) => replayResult,
  },
});

const { registerCoreHandlers } = await import("../src/daemon/core-handlers.js");
const { _internal, invalidateSnapshotCache } = await import("../src/adapters/iterm/core.js");
const { setAppDir, setPersistentSessionName, setHolderLivenessProbe, DEFAULT_VOICE_CONFIG } = await import("../src/core/persistence.js");
const { setVoiceConfig: setStateVoice } = await import("../src/core/state.js");
import type { IpcHandler } from "../src/ipc/server.js";

setAppDir(scratch);
setStateVoice({ ...DEFAULT_VOICE_CONFIG });

function registerAndCapture(): Map<string, IpcHandler> {
  const handlers = new Map<string, IpcHandler>();
  const fakeServer = { on: (method: string, handler: IpcHandler) => handlers.set(method, handler) };
  registerCoreHandlers(fakeServer as any, {} as any, {} as any, {} as any);
  return handlers;
}

const snap = (id: string, tabTitle: string): Record<string, unknown> => ({
  id, name: "claude (node)", profileName: "Default", tty: "/dev/ttysX", atPrompt: false,
  paiName: null, tabTitle,
});

function stubSnapshot(rows: Record<string, unknown>[]) {
  const original = _internal.runItermJxa;
  _internal.snapshotAllSessions = async () => rows as any;
  invalidateSnapshotCache();
  return { restore: () => { _internal.snapshotAllSessions = original; invalidateSnapshotCache(); } };
}

const req = (method: string, params: Record<string, unknown>, itermSessionId?: string) =>
  ({ id: "r", sessionId: "x", method, params, ...(itermSessionId ? { itermSessionId } : {}) }) as any;

test("voice_config get with session self returns the caller's settings", async () => {
  const handlers = registerAndCapture();
  const stub = stubSnapshot([snap("vh-self", "Self Tab")]);
  try {
    const r = await handlers.get("voice_config")!(req("voice_config", { action: "get", session: "self" }, "w0t0p0:vh-self"));
    assert.equal(r.ok, true);
    const s = (r as any).result.session;
    assert.equal(s.key, "session:vh-self");
    assert.equal(s.replyInVoice, false);
    assert.equal(s.speed, 1);
  } finally { stub.restore(); }
});

test("voice_config set replyInVoice is per-session and leaves global config alone", async () => {
  const handlers = registerAndCapture();
  const stub = stubSnapshot([snap("vh-a", "A Tab"), snap("vh-b", "B Tab")]);
  try {
    await handlers.get("voice_config")!(req("voice_config", { action: "set", session: "self", replyInVoice: true }, "w0t0p0:vh-a"));
    const other = await handlers.get("voice_config")!(req("voice_config", { action: "get", session: "self" }, "w0t0p0:vh-b"));
    assert.equal((other as any).result.session.replyInVoice, false, "another session is untouched");

    const global = await handlers.get("voice_config")!(req("voice_config", { action: "get" }));
    assert.equal((global as any).result.config.defaultVoice, DEFAULT_VOICE_CONFIG.defaultVoice, "global config unchanged");

    // caller with no pane at all falls back to its claimed session id
    const anon = await handlers.get("voice_config")!(req("voice_config", { action: "get" }));
    assert.equal((anon as any).result.config.defaultVoice, DEFAULT_VOICE_CONFIG.defaultVoice);
  } finally { stub.restore(); }
});

test("speedDelta nudges the session speed and clamps", async () => {
  const handlers = registerAndCapture();
  const stub = stubSnapshot([snap("vh-s", "S Tab")]);
  try {
    await handlers.get("voice_config")!(req("voice_config", { action: "set", session: "self", speedDelta: -0.1 }, "w0t0p0:vh-s"));
    let r = await handlers.get("voice_config")!(req("voice_config", { action: "get", session: "self" }, "w0t0p0:vh-s"));
    assert.equal((r as any).result.session.speed, 0.9);
    await handlers.get("voice_config")!(req("voice_config", { action: "set", session: "self", speedDelta: -10 }, "w0t0p0:vh-s"));
    r = await handlers.get("voice_config")!(req("voice_config", { action: "get", session: "self" }, "w0t0p0:vh-s"));
    assert.equal((r as any).result.session.speed, 0.5);
  } finally { stub.restore(); }
});

test("named session target resolves through the shared matcher; unknown name errors", async () => {
  const handlers = registerAndCapture();
  // liveness check must not reach a real ps scan; the holder is this fixture row
  setHolderLivenessProbe((id: string) => (id === "vh-named" ? "live" : "gone"));
  await setPersistentSessionName("vh-named", "VoiceNotes");
  const stub = stubSnapshot([snap("vh-named", "VoiceNotes-smooth-fiddle"), snap("vh-other", "Other")]);
  try {
    const r = await handlers.get("voice_config")!(req("voice_config", { action: "set", session: "voicenotes", replyInVoice: true }));
    assert.equal(r.ok, true);
    assert.equal((r as any).result.session.key, "session:VoiceNotes", "chosen name is the key");

    const miss = await handlers.get("voice_config")!(req("voice_config", { action: "get", session: "no-such-session" }));
    assert.equal(miss.ok, false);
    assert.match((miss as any).error, /not found/);
  } finally { stub.restore(); }
});

test("speak queues with explicit > session > global precedence", async () => {
  enqueued = [];
  const handlers = registerAndCapture();
  const stub = stubSnapshot([snap("vh-sp", "Sp Tab")]);
  try {
    await handlers.get("voice_config")!(req("voice_config", { action: "set", session: "self", voice: "af_bella", speedDelta: -0.2 }, "w0t0p0:vh-sp"));

    const r = await handlers.get("speak")!(req("speak", { text: "hello" }, "w0t0p0:vh-sp"));
    assert.equal(r.ok, true);
    assert.deepEqual((r as any).result, { speaking: true, queued: 1 });
    assert.deepEqual(enqueued[0], { session: "session:vh-sp", text: "hello", voice: "af_bella", speed: 0.8 }, "session settings applied");

    enqueued = [];
    await handlers.get("speak")!(req("speak", { text: "hi", voice: "am_adam", speed: 1.5 }, "w0t0p0:vh-sp"));
    assert.deepEqual(enqueued[0], { session: "session:vh-sp", text: "hi", voice: "am_adam", speed: 1.5 }, "explicit params win");

    enqueued = [];
    await handlers.get("speak")!(req("speak", { text: "g" }, "w0t0p0:vh-unset"));
    assert.equal(enqueued[0].voice, DEFAULT_VOICE_CONFIG.defaultVoice, "unset session falls to global default");
    assert.equal(enqueued[0].speed, 1);

    const bad = await handlers.get("speak")!(req("speak", {}));
    assert.equal(bad.ok, false);
  } finally { stub.restore(); }
});

test("speak_stop returns the playback result; speak_repeat errors when nothing to replay", async () => {
  const handlers = registerAndCapture();
  const stub = stubSnapshot([snap("vh-rp", "Rp Tab")]);
  try {
    const stop = await handlers.get("speak_stop")!(req("speak_stop", {}));
    assert.deepEqual((stop as any).result, { stopped: true, cleared: 2 });

    replayResult = false;
    const miss = await handlers.get("speak_repeat")!(req("speak_repeat", {}, "w0t0p0:vh-rp"));
    assert.equal(miss.ok, false);
    assert.match((miss as any).error, /nothing to repeat/);

    replayResult = true;
    const hit = await handlers.get("speak_repeat")!(req("speak_repeat", {}, "w0t0p0:vh-rp"));
    assert.deepEqual((hit as any).result, { repeated: true });
  } finally { stub.restore(); }
});
