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

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { log } from "../../core/log.js";
import { handleInboundPublish, setMqttOutTap } from "./mqtt-broker.js";
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
}

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

function resetSession(): void {
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

function sendEnvelope(env: BleEnvelope, key: Buffer | null = sessionKey): void {
  if (!status.connected || !key) return;
  const frame = encodeFrame(env, key);
  for (const c of chunk(frame, status.mtu)) helperSend({ cmd: "tx", b64: c.toString("base64") });
}

function sendRetained(): void {
  for (const [topic, json] of retained) {
    try { sendEnvelope({ t: topic, p: JSON.parse(json) }); } catch { /* skip bad */ }
  }
}

function onOutbound(topic: string, json: string, opts: { retain: boolean }): void {
  if (opts.retain) {
    if (!json) { retained.delete(topic); return; }
    retained.set(topic, json);
  }
  if (!json) return;
  if (!status.ready) return;
  try { sendEnvelope({ t: topic, p: JSON.parse(json) }); }
  catch (err) { log(`[BLE] outbound ${topic} failed: ${err}`); }
}

function dropLink(why: string): void {
  log(`[BLE] dropping link: ${why}`);
  status.ready = false;
  sessionKey = null;
  rejected = true;
  reassembler.reset();
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
    );
    sessionKey = ks;
    status.ready = true;
    log(`[BLE] link ready (app ${typeof p.app === "string" ? p.app : "?"})`);
    sendRetained();
    return;
  }
  if (env.t === "ble/ping") { sendEnvelope({ t: "ble/pong", p: {} }); return; }
  if (env.t === "ble/hello") return;
  const p = env.p as { type?: unknown } | null;
  if (p && p.type === "voice") log("[BLE] voice note -> local STT");
  handleInboundPublish({ topic: env.t, payload: Buffer.from(JSON.stringify(env.p ?? {})) }, FAKE_CLIENT);
}

function onHelperEvent(ev: Record<string, unknown>): void {
  switch (ev.ev) {
    case "ready":
      helperSend({ cmd: "start", name: state?.name, service: BLE_SERVICE_UUID });
      break;
    case "advertising":
      status.advertising = true;
      log(`[BLE] advertising as "${ev.name}"`);
      break;
    case "central":
      status.connected = ev.connected === true;
      status.centralId = status.connected ? String(ev.id ?? "") : null;
      status.ready = false;
      resetSession();
      if (!status.connected) status.mtu = DEFAULT_CHUNK;
      log(`[BLE] central ${status.connected ? "connected" : "disconnected"} ${ev.id ?? ""}`);
      break;
    case "mtu":
      if (typeof ev.n === "number" && ev.n > 0) status.mtu = Math.min(512, ev.n);
      break;
    case "rx": {
      if (typeof ev.b64 !== "string") break;
      try {
        reassembler.push(Buffer.from(ev.b64, "base64"), onEnvelope);
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
  Object.assign(status, { enabled: false, helperRunning: false, advertising: false, connected: false, ready: false, centralId: null, mtu: DEFAULT_CHUNK, authFailures: 0 });
}
