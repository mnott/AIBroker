/**
 * adapters/pailot/ble-bridge.ts — BLE transport for PAILot.
 *
 * Spawns the native CoreBluetooth peripheral helper (native/ble-peripheral),
 * speaks its JSON-lines protocol on stdin/stdout, and carries the SAME
 * (mqtt-topic, json-payload) pairs the app exchanges over MQTT:
 *   inbound  -> handleInboundPublish (dedup, voice -> transcribeAndRoute, commands)
 *   outbound -> setMqttOutTap in mqtt-broker.ts
 * Enabled with AIBROKER_BLE=1; AIBROKER_BLE_TOKEN is required.
 * See docs/ble-transport.md.
 */

import { spawn as nodeSpawn, execFile, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { log } from "../../core/log.js";
import { getMqttAppClientCount, handleInboundPublish, setMqttOutTap, type MqttOutResult } from "./mqtt-broker.js";
import { deriveK0, deriveKs, readyMac } from "./ble-crypto.js";
import { chunk, DEFAULT_CHUNK, encodeFrame, FrameReassembler, type BleEnvelope } from "./ble-frame.js";

export const BLE_SERVICE_UUID = "7A1F0001-3C5B-4D2E-9A41-5041494C4F54";
const DEFAULT_NAME = "PAILot Hub";

export interface BleStatus {
  enabled: boolean;
  helperRunning: boolean;
  advertising: boolean;
  connected: boolean;
  ready: boolean;
  mtu: number;
  centralId: string | null;
  authFailures: number;
}

export interface BleBridgeOptions {
  env?: NodeJS.ProcessEnv;
  /** Test seam: replaces child_process.spawn. */
  spawn?: (cmd: string, args: string[]) => ChildProcess;
  /** Test seam: backoff base in ms. */
  backoffMs?: number;
  /** Test seam: MQTT app client count (default getMqttAppClientCount). */
  mqttAppClients?: () => number;
  /** Test seam: image downscaler (base64 in -> base64 JPEG out, null = failed). */
  downscaleImage?: (b64: string) => Promise<string | null>;
  /** Test seam: audio compressor (base64 in -> base64 m4a out, null = failed). */
  compressAudio?: (b64: string) => Promise<string | null>;
}

const BULK_TYPES = new Set(["image", "screenshot", "file"]);
export const DEFAULT_BLE_MAX_PAYLOAD = 64 * 1024;
export const BLE_AUDIO_MAX = 1024 * 1024;

export interface RouteInput {
  type: string;
  size: number;
  mqttAppClients: number;
  bleReady: boolean;
  maxPayload?: number;
}
export interface RouteDecision { ble: boolean; mqtt: boolean; large: boolean; reason: string }

/** Pure per-message link decision. Large payloads use exactly one link (BLE xor MQTT). */
export function routeOutbound(i: RouteInput): RouteDecision {
  const max = i.maxPayload ?? DEFAULT_BLE_MAX_PAYLOAD;
  const large = BULK_TYPES.has(i.type) || i.size > max;
  if (!large) return { ble: i.bleReady, mqtt: true, large, reason: "small" };
  if (i.mqttAppClients > 0) return { ble: false, mqtt: true, large, reason: "large, mqtt client connected" };
  if (i.bleReady) return { ble: true, mqtt: false, large, reason: "large, no mqtt client, ble only (reduced)" };
  return { ble: false, mqtt: true, large, reason: "large, no ble" };
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((res, rej) => execFile(cmd, args, { timeout: 30000 }, (e) => (e ? rej(e) : res())));
}

async function viaTemp(b64: string, inName: string, outName: string, args: (i: string, o: string) => [string, string[]]): Promise<string | null> {
  const dir = await mkdtemp(join(tmpdir(), "aib-ble-"));
  try {
    const i = join(dir, inName), o = join(dir, outName);
    await writeFile(i, Buffer.from(b64, "base64"));
    const [cmd, a] = args(i, o);
    await run(cmd, a);
    return (await readFile(o)).toString("base64");
  } catch (err) {
    log(`[BLE] ${args("", "")[0]} failed: ${err}`);
    return null;
  } finally { await rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

export const sipsDownscale = (b64: string): Promise<string | null> =>
  viaTemp(b64, "in.img", "out.jpg", (i, o) => ["sips", ["-s", "format", "jpeg", "-s", "formatOptions", "70", "-Z", "1280", i, "--out", o]]);

export const afconvertAac = (b64: string): Promise<string | null> => {
  const head = Buffer.from(b64.slice(0, 16), "base64");
  if (head.subarray(4, 8).toString() === "ftyp") return Promise.resolve(b64); // already m4a
  return viaTemp(b64, "in.audio", "out.m4a", (i, o) => ["afconvert", ["-f", "m4af", "-d", "aac", i, o]]);
};

const FAKE_CLIENT = { id: "pailot-ble", conn: { remoteAddress: "ble" } };

let state: {
  opts: BleBridgeOptions;
  token: string;
  k0: Buffer;
  name: string;
  helperPath: string;
  child: ChildProcess | null;
  stopped: boolean;
  restartTimer: ReturnType<typeof setTimeout> | null;
  attempt: number;
} | null = null;

const status: BleStatus = {
  enabled: false, helperRunning: false, advertising: false,
  connected: false, ready: false, mtu: DEFAULT_CHUNK, centralId: null, authFailures: 0,
};
/** Per-connection session key; null until the handshake completes. */
let sessionKey: Buffer | null = null;
let reassembler = newReassembler();

function newReassembler(): FrameReassembler {
  const r = new FrameReassembler(() => sessionKey ?? state?.k0 ?? null);
  r.onAuthFailure = onAuthFailure;
  return r;
}

/** Un-acked bytes allowed in the helper when it announced flow control. */
const MAX_INFLIGHT = 64 * 1024;

interface Sched {
  ctrl: Buffer[][];
  bulk: Buffer[][];
  cur: Buffer[];
  curIdx: number;
  inflight: number;
  queued: number;
}
const sched: Sched = { ctrl: [], bulk: [], cur: [], curIdx: 0, inflight: 0, queued: 0 };
let helperFlow = false;

function resetSched(): void {
  clearLatencyTimer(); latencyLow = false;
  sched.ctrl = []; sched.bulk = []; sched.cur = []; sched.curIdx = 0; sched.inflight = 0; sched.queued = 0;
}

/** Per-session liveness counters (reset on central connect). */
const sess = {
  startedAt: Date.now(), readyAt: 0, lastRx: 0,
  rxBytes: 0, rxFrames: 0, txBytes: 0, txFrames: 0, pings: 0, pongs: 0,
};
function resetCounters(): void {
  Object.assign(sess, { startedAt: Date.now(), readyAt: 0, lastRx: 0, rxBytes: 0, rxFrames: 0, txBytes: 0, txFrames: 0, pings: 0, pongs: 0 });
}
const secs = (t: number): string => (t ? ((Date.now() - t) / 1000).toFixed(1) : "-");
function counters(): string {
  return `ready=${status.ready}, rx=${sess.rxBytes}B/${sess.rxFrames}fr, tx=${sess.txBytes}B/${sess.txFrames}fr, ` +
    `pings=${sess.pings}, pongs=${sess.pongs}, lastRx=${secs(sess.lastRx)}s ago, ` +
    `rxPartial=${reassembler.pendingBytes}/${reassembler.expectedBytes}B, txQueued=${sched.queued}B, inflight=${sched.inflight}B`;
}

/** Queued bytes above which the link is switched to low latency (fast interval) for the transfer. */
const BULK_LOW_LATENCY_BYTES = 8 * 1024;
/** Quiet time after the last bulk byte before returning to high latency (radio-friendly idle). */
const LATENCY_IDLE_MS = 1000;
let latencyLow = false;
let latencyTimer: ReturnType<typeof setTimeout> | null = null;

function setLatency(mode: "low" | "high"): void {
  if (latencyLow === (mode === "low")) return;
  latencyLow = mode === "low";
  helperSend({ cmd: "latency", mode });
}

function clearLatencyTimer(): void {
  if (latencyTimer) { clearTimeout(latencyTimer); latencyTimer = null; }
}

function noteLatency(): void {
  // Inbound bulk: a partially received frame whose header announced >= threshold.
  const rxBulk = reassembler.expectedBytes >= BULK_LOW_LATENCY_BYTES;
  if (sched.queued + sched.inflight >= BULK_LOW_LATENCY_BYTES || rxBulk) {
    clearLatencyTimer();
    setLatency("low");
  } else if (latencyLow && sched.queued === 0 && sched.inflight === 0) {
    if (latencyTimer) return;
    latencyTimer = setTimeout(() => { latencyTimer = null; setLatency("high"); }, LATENCY_IDLE_MS);
    latencyTimer.unref?.();
  }
}

function pump(): void {
  noteLatency();
  pumpInner();
  noteLatency();
}

function pumpInner(): void {
  for (;;) {
    if (helperFlow && sched.inflight >= MAX_INFLIGHT) return;
    if (sched.curIdx >= sched.cur.length) {
      const next = sched.ctrl.shift() ?? sched.bulk.shift();
      if (!next) return;
      sched.cur = next; sched.curIdx = 0;
    }
    const c = sched.cur[sched.curIdx++];
    sched.queued -= c.length;
    sched.inflight += c.length;
    helperSend({ cmd: "tx", b64: c.toString("base64") });
  }
}

function resetSession(): void {
  resetSched();
  sessionKey = null;
  rejected = false;
  reassembler = newReassembler();
}
const retained = new Map<string, string>();

export function getBleStatus(): BleStatus {
  return { ...status };
}

export function resolveBleHelperPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AIBROKER_BLE_HELPER) return env.AIBROKER_BLE_HELPER;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "../../ble/pailot-ble"),       // dist/adapters/pailot -> dist/ble
    join(here, "../../../dist/ble/pailot-ble"), // src/adapters/pailot -> dist/ble
  ];
  return candidates.find(existsSync) ?? candidates[0];
}

function helperSend(obj: Record<string, unknown>): void {
  const stdin = state?.child?.stdin;
  if (!stdin || stdin.destroyed) return;
  stdin.write(JSON.stringify(obj) + "\n");
}

function sendEnvelope(env: BleEnvelope, key: Buffer | null = sessionKey, control = false): void {
  if (!status.connected || !key) return;
  const frame = encodeFrame(env, key);
  const chunks = chunk(frame, status.mtu);
  sess.txBytes += frame.length; sess.txFrames++;
  sched.queued += frame.length;
  (control ? sched.ctrl : sched.bulk).push(chunks);
  pump();
}

function sendRetained(): void {
  for (const [topic, json] of retained) {
    try { sendEnvelope({ t: topic, p: JSON.parse(json) }); } catch { /* skip bad */ }
  }
}

function sendLogged(topic: string, p: unknown): void {
  try { sendEnvelope({ t: topic, p }); }
  catch (err) { log(`[BLE] outbound ${topic} failed: ${err}`); }
}

/** Shrink a large payload for BLE. Returns the payload to send, or null to drop. */
async function reduceForBle(topic: string, p: Record<string, unknown>, type: string): Promise<Record<string, unknown> | null> {
  const o = state?.opts ?? {};
  if (type === "image" || type === "screenshot") {
    const src = typeof p.imageBase64 === "string" ? p.imageBase64 : null;
    if (!src) { log(`[BLE] drop ${topic} type=${type}: no imageBase64`); return null; }
    const out = await (o.downscaleImage ?? sipsDownscale)(src);
    if (!out) { log(`[BLE] drop ${topic} type=${type}: downscale failed`); return null; }
    return { ...p, imageBase64: out, mimeType: "image/jpeg" };
  }
  if (type === "voice") {
    const src = typeof p.audioBase64 === "string" ? p.audioBase64 : null;
    if (!src) return p;
    const out = await (o.compressAudio ?? afconvertAac)(src);
    if (!out) { log(`[BLE] drop ${topic} type=voice: compress failed`); return null; }
    if (out.length > BLE_AUDIO_MAX) { log(`[BLE] drop ${topic} type=voice: ${out.length}B after compress > ${BLE_AUDIO_MAX}`); return null; }
    return { ...p, audioBase64: out };
  }
  if (Buffer.byteLength(JSON.stringify(p)) > BLE_AUDIO_MAX) { log(`[BLE] drop ${topic} type=${type}: too large for BLE`); return null; }
  return p;
}

function onOutbound(topic: string, json: string, opts: { retain: boolean }): MqttOutResult | void {
  if (opts.retain) {
    if (!json) { retained.delete(topic); return; }
    retained.set(topic, json);
  }
  if (!json) return;
  let p: Record<string, unknown> | null = null;
  try { p = JSON.parse(json); } catch { /* not json */ }
  const type = p && typeof p.type === "string" ? p.type : "?";
  const maxPayload = Number(state?.opts.env?.AIBROKER_BLE_MAX_PAYLOAD ?? process.env.AIBROKER_BLE_MAX_PAYLOAD) || DEFAULT_BLE_MAX_PAYLOAD;
  const d = routeOutbound({
    type, size: json.length, maxPayload, bleReady: status.ready && p !== null,
    mqttAppClients: (state?.opts.mqttAppClients ?? getMqttAppClientCount)(),
  });
  const link = d.ble && d.mqtt ? "both" : d.ble ? "ble" : "mqtt";
  log(`[LINK] out topic=${topic} type=${type} bytes=${json.length} -> ${link} (${d.reason})`);
  if (d.ble && p) {
    if (!d.large || (type !== "image" && type !== "screenshot" && type !== "voice")) {
      if (json.length > BLE_AUDIO_MAX) log(`[BLE] drop ${topic} type=${type}: too large for BLE`);
      else sendLogged(topic, p);
    } else void reduceForBle(topic, p, type).then((r) => { if (r && status.ready) sendLogged(topic, r); })
      .catch((err) => log(`[BLE] reduce ${topic} failed: ${err}`));
  }
  return { skipMqtt: !d.mqtt };
}

function dropLink(why: string): void {
  log(`[BLE] dropping link: ${why} (${counters()})`);
  status.ready = false;
  sessionKey = null;
  rejected = true;
  reassembler.reset();
  resetSched();
  helperSend({ cmd: "drop" });
}

let rejected = false;

function onAuthFailure(body: Buffer): void {
  status.authFailures++;
  if (status.ready || rejected) return; // after ready: dropped and counted only
  let v1 = false;
  try { v1 = JSON.parse(body.toString("utf8"))?.t === "ble/hello"; } catch { /* not json */ }
  if (v1) log("BLE: rejected v1 peer (plaintext hello) - update PAILot to >=1.1.13");
  dropLink(v1 ? "v1 plaintext hello" : "handshake authentication failed (wrong token?)");
}

function onEnvelope(env: BleEnvelope): void {
  if (!state) return;
  if (!status.ready) {
    if (rejected) return;
    if (env.t !== "ble/hello") return; // ignore everything until hello
    const p = env.p as { app?: unknown; v?: unknown; n?: unknown } | null;
    if (!p || p.v !== 2 || typeof p.n !== "string" || !/^[0-9a-f]{32}$/i.test(p.n)) {
      dropLink("hello with bad version or nonce");
      return;
    }
    const clientNonce = Buffer.from(p.n, "hex");
    const serverNonce = randomBytes(16);
    const ks = deriveKs(state.k0, clientNonce, serverNonce);
    sendEnvelope(
      { t: "ble/ready", p: { v: 2, n: serverNonce.toString("hex"), mac: readyMac(ks, clientNonce, serverNonce) } },
      state.k0,
      true,
    );
    sessionKey = ks;
    status.ready = true;
    sess.readyAt = Date.now();
    log(`[BLE] link ready (app ${typeof p.app === "string" ? p.app : "?"})`);
    sendRetained();
    return;
  }
  if (env.t === "ble/ping") {
    sess.pings++;
    sendEnvelope({ t: "ble/pong", p: {} }, sessionKey, true);
    sess.pongs++;
    if (sess.pings % 10 === 0) log(`[BLE] ping summary: pings=${sess.pings}, pongs=${sess.pongs}, ready ${secs(sess.readyAt)}s, rx=${sess.rxBytes}B, tx=${sess.txBytes}B`);
    return;
  }
  if (env.t === "ble/hello") return;
  const p = env.p as { type?: unknown } | null;
  log(`[LINK] in topic=${env.t} type=${typeof p?.type === "string" ? p.type : "?"} bytes=${JSON.stringify(env.p ?? {}).length} via ble`);
  if (p && p.type === "voice") log("[BLE] voice note -> local STT");
  handleInboundPublish({ topic: env.t, payload: Buffer.from(JSON.stringify(env.p ?? {})) }, FAKE_CLIENT);
}

function onHelperEvent(ev: Record<string, unknown>): void {
  switch (ev.ev) {
    case "ready":
      helperFlow = ev.flow === 1;
      helperSend({ cmd: "start", name: state?.name, service: BLE_SERVICE_UUID });
      break;
    case "advertising":
      status.advertising = ev.on !== false;
      if (ev.on === false) log("[BLE] advertising stopped (central connected)");
      else log(`[BLE] advertising as "${ev.name}"`);
      break;
    case "central":
      {
        const wasConnected = status.connected;
        const prev = counters();
        const upFor = ((Date.now() - sess.startedAt) / 1000).toFixed(0);
        status.connected = ev.connected === true;
        status.centralId = status.connected ? String(ev.id ?? "") : null;
        status.ready = false;
        resetSession();
        resetCounters();
        if (!status.connected) status.mtu = DEFAULT_CHUNK;
        if (!status.connected && wasConnected) log(`[BLE] central disconnected ${ev.id ?? ""} after ${upFor}s ${prev}`);
        else log(`[BLE] central ${status.connected ? "connected" : "disconnected"} ${ev.id ?? ""}`);
      }
      break;
    case "mtu":
      if (typeof ev.n === "number" && ev.n > 0) status.mtu = Math.min(512, ev.n);
      break;
    case "sent":
      if (typeof ev.n === "number") { sched.inflight = Math.max(0, sched.inflight - ev.n); pump(); }
      break;
    case "rx": {
      if (typeof ev.b64 !== "string") break;
      try {
        const raw = Buffer.from(ev.b64, "base64");
        sess.rxBytes += raw.length; sess.lastRx = Date.now();
        reassembler.push(raw, (e) => { sess.rxFrames++; onEnvelope(e); });
        noteLatency();
      } catch (err) {
        dropLink(`framing error: ${err instanceof Error ? err.message : err}`);
      }
      break;
    }
    case "error":
      log(`[BLE] helper error: ${ev.msg}`);
      break;
  }
}

function launch(): void {
  if (!state || state.stopped) return;
  const s = state;
  const spawnFn = s.opts.spawn ?? ((cmd, args) => nodeSpawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] }));
  let child: ChildProcess;
  try {
    child = spawnFn(s.helperPath, []);
  } catch (err) {
    log(`[BLE] helper spawn failed: ${err}`);
    scheduleRestart();
    return;
  }
  s.child = child;
  status.helperRunning = true;
  child.on("error", (err) => log(`[BLE] helper error: ${err.message}`));
  child.stdin?.on("error", () => { /* helper gone */ });
  child.stderr?.on("data", (d: Buffer) => log(`[BLE] helper: ${d.toString().trimEnd()}`));
  if (child.stdout) {
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (!line.trim()) return;
      try { onHelperEvent(JSON.parse(line)); }
      catch (err) { log(`[BLE] bad helper line: ${line.slice(0, 120)}`); }
    });
  }
  child.on("exit", (code, sig) => {
    if (state?.child !== child) return;
    log(`[BLE] helper exited (code=${code} sig=${sig})`);
    state.child = null;
    status.helperRunning = false;
    status.advertising = false;
    status.connected = false;
    status.ready = false;
    status.centralId = null;
    status.mtu = DEFAULT_CHUNK;
    helperFlow = false;
    resetSched();
    scheduleRestart();
  });
}

function scheduleRestart(): void {
  if (!state || state.stopped) return;
  const base = state.opts.backoffMs ?? 1000;
  const delay = Math.min(30_000, base * 2 ** Math.min(state.attempt, 5));
  state.attempt++;
  state.restartTimer = setTimeout(() => { if (state) { state.restartTimer = null; launch(); } }, delay);
  state.restartTimer.unref?.();
}

/** Start the BLE bridge if AIBROKER_BLE=1. Returns true when started. */
export function startBleBridge(opts: BleBridgeOptions = {}): boolean {
  const env = opts.env ?? process.env;
  if (env.AIBROKER_BLE !== "1") return false;
  const token = env.AIBROKER_BLE_TOKEN;
  if (!token) { log("[BLE] AIBROKER_BLE_TOKEN not set — BLE transport disabled"); return false; }
  if (state) stopBleBridge();
  state = {
    opts, token, k0: deriveK0(token),
    name: env.AIBROKER_BLE_NAME || DEFAULT_NAME,
    helperPath: resolveBleHelperPath(env),
    child: null, stopped: false, restartTimer: null, attempt: 0,
  };
  status.enabled = true;
  resetSession();
  status.authFailures = 0;
  setMqttOutTap(onOutbound);
  log(`[BLE] starting helper ${state.helperPath}`);
  launch();
  return true;
}

export function stopBleBridge(): void {
  if (!state) return;
  state.stopped = true;
  if (state.restartTimer) clearTimeout(state.restartTimer);
  helperSend({ cmd: "quit" });
  const child = state.child;
  if (child) setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 500).unref?.();
  setMqttOutTap(null);
  retained.clear();
  state = null;
  sessionKey = null;
  helperFlow = false;
  resetSched();
  Object.assign(status, { enabled: false, helperRunning: false, advertising: false, connected: false, ready: false, centralId: null, mtu: DEFAULT_CHUNK, authFailures: 0 });
}
