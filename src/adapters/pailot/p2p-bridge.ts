/**
 * adapters/pailot/p2p-bridge.ts — Wi-Fi direct (MultipeerConnectivity) transport for PAILot.
 *
 * Spawns native/p2p-peripheral (MCNearbyServiceAdvertiser), speaks JSON lines on stdin/stdout.
 * Carries the same (mqtt-topic, json) envelopes as the BLE link, with the BLE framing
 * (ble-frame.ts) and v2 AES-256-GCM handshake (ble-crypto.ts). Differences from BLE:
 * several peers may be connected, there is no size routing (large payloads allowed), and chunks
 * are 64 KiB. Enabled with AIBROKER_P2P=1; AIBROKER_P2P_TOKEN (falls back to AIBROKER_BLE_TOKEN).
 * See docs/p2p-transport.md.
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
import { chunk, encodeFrame, FrameReassembler, type BleEnvelope } from "./ble-frame.js";

export const P2P_SERVICE_TYPE = "pailot-p2p";
export const P2P_CHUNK = 64 * 1024;
/** Default must exceed the app's hello retry window (5 s) so a peer needing its last retry is kept. */
export const P2P_AUTH_TIMEOUT_MS = 15000;

function authTimeoutMs(): number {
  const n = Number(state?.opts.env?.AIBROKER_P2P_AUTH_TIMEOUT_MS ?? process.env.AIBROKER_P2P_AUTH_TIMEOUT_MS);
  return state?.opts.authTimeoutMs ?? (Number.isFinite(n) && n > 0 ? n : P2P_AUTH_TIMEOUT_MS);
}
const DEFAULT_NAME = "PAILot Hub";
const FAKE_CLIENT = { id: "pailot-p2p", conn: { remoteAddress: "p2p" } };

export interface P2pStatus {
  enabled: boolean;
  helperRunning: boolean;
  advertising: boolean;
  peers: number;
  readyPeers: number;
  authFailures: number;
}

export interface P2pBridgeOptions {
  env?: NodeJS.ProcessEnv;
  /** Test seam: replaces child_process.spawn. */
  spawn?: (cmd: string, args: string[]) => ChildProcess;
  /** Test seam: backoff base in ms. */
  backoffMs?: number;
  /** Test seam: unauthenticated-peer timeout. */
  authTimeoutMs?: number;
}

interface Peer {
  id: string;
  key: Buffer | null;
  ready: boolean;
  rejected: boolean;
  reassembler: FrameReassembler;
  timer: ReturnType<typeof setTimeout> | null;
}

let state: {
  opts: P2pBridgeOptions;
  k0: Buffer;
  name: string;
  helperPath: string;
  child: ChildProcess | null;
  stopped: boolean;
  restartTimer: ReturnType<typeof setTimeout> | null;
  attempt: number;
} | null = null;

const peers = new Map<string, Peer>();
const retained = new Map<string, string>();
const status: P2pStatus = { enabled: false, helperRunning: false, advertising: false, peers: 0, readyPeers: 0, authFailures: 0 };

function refreshCounts(): void {
  status.peers = peers.size;
  status.readyPeers = [...peers.values()].filter((p) => p.ready).length;
}

export function getP2pStatus(): P2pStatus {
  return { ...status };
}

export function resolveP2pHelperPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AIBROKER_P2P_HELPER) return env.AIBROKER_P2P_HELPER;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "../../p2p/pailot-p2p"),
    join(here, "../../../dist/p2p/pailot-p2p"),
  ];
  return candidates.find(existsSync) ?? candidates[0];
}

function helperSend(obj: Record<string, unknown>): void {
  const stdin = state?.child?.stdin;
  if (!stdin || stdin.destroyed) return;
  stdin.write(JSON.stringify(obj) + "\n");
}

function sendTo(peer: Peer, env: BleEnvelope, key: Buffer | null = peer.key): void {
  if (!key) return;
  for (const c of chunk(encodeFrame(env, key), P2P_CHUNK)) {
    helperSend({ cmd: "send", peer: peer.id, b64: c.toString("base64") });
  }
}

function newPeer(id: string): Peer {
  const peer: Peer = { id, key: null, ready: false, rejected: false, timer: null, reassembler: null as unknown as FrameReassembler };
  peer.reassembler = new FrameReassembler(() => peer.key ?? state?.k0 ?? null);
  peer.reassembler.onAuthFailure = () => {
    status.authFailures++;
    if (!peer.ready) dropPeer(peer, "handshake authentication failed (wrong token or v1 peer)");
  };
  const ms = authTimeoutMs();
  peer.timer = setTimeout(() => {
    if (!peer.ready) dropPeer(peer, `no v2 handshake within ${ms}ms`);
  }, ms);
  peer.timer.unref?.();
  return peer;
}

function dropPeer(peer: Peer, why: string): void {
  log(`[P2P] dropping peer ${peer.id}: ${why}`);
  peer.rejected = true;
  peer.ready = false;
  peer.key = null;
  helperSend({ cmd: "disconnect", peer: peer.id });
  refreshCounts();
}

function forget(id: string): void {
  const p = peers.get(id);
  if (p?.timer) clearTimeout(p.timer);
  peers.delete(id);
  refreshCounts();
}

function onEnvelope(peer: Peer, env: BleEnvelope): void {
  if (!state || peer.rejected) return;
  if (!peer.ready) {
    if (env.t !== "ble/hello") return;
    const p = env.p as { app?: unknown; v?: unknown; n?: unknown } | null;
    if (!p || p.v !== 2 || typeof p.n !== "string" || !/^[0-9a-f]{32}$/i.test(p.n)) {
      dropPeer(peer, "hello with bad version or nonce");
      return;
    }
    const cn = Buffer.from(p.n, "hex");
    const sn = randomBytes(16);
    const ks = deriveKs(state.k0, cn, sn);
    sendTo(peer, { t: "ble/ready", p: { v: 2, n: sn.toString("hex"), mac: readyMac(ks, cn, sn) } }, state.k0);
    peer.key = ks;
    peer.ready = true;
    if (peer.timer) { clearTimeout(peer.timer); peer.timer = null; }
    refreshCounts();
    log(`[P2P] link ready (peer ${peer.id}, app ${typeof p.app === "string" ? p.app : "?"})`);
    for (const [topic, json] of retained) {
      try { sendTo(peer, { t: topic, p: JSON.parse(json) }); } catch { /* skip bad */ }
    }
    return;
  }
  if (env.t === "ble/ping") { sendTo(peer, { t: "ble/pong", p: {} }); return; }
  if (env.t === "ble/hello") return;
  const p = env.p as { type?: unknown } | null;
  log(`[LINK] in topic=${env.t} type=${typeof p?.type === "string" ? p.type : "?"} bytes=${JSON.stringify(env.p ?? {}).length} via p2p`);
  handleInboundPublish({ topic: env.t, payload: Buffer.from(JSON.stringify(env.p ?? {})) }, FAKE_CLIENT);
}

function onOutbound(topic: string, json: string, opts: { retain: boolean }): void {
  if (opts.retain) {
    if (!json) { retained.delete(topic); return; }
    retained.set(topic, json);
  }
  if (!json || status.readyPeers === 0) return;
  let p: unknown;
  try { p = JSON.parse(json); } catch { return; }
  for (const peer of peers.values()) {
    if (!peer.ready) continue;
    try { sendTo(peer, { t: topic, p }); } catch (err) { log(`[P2P] outbound ${topic} failed: ${err}`); }
  }
}

function onHelperEvent(ev: Record<string, unknown>): void {
  switch (ev.ev) {
    case "ready":
      log("[P2P] helper ready");
      break;
    case "advertising":
      status.advertising = ev.on !== false;
      log(`[P2P] advertising as "${ev.name ?? state?.name}"`);
      break;
    case "peer": {
      const id = String(ev.id ?? "");
      if (!id) break;
      if (ev.state === "connected") {
        forget(id);
        peers.set(id, newPeer(id));
        log(`[P2P] peer connected ${id} (${ev.name ?? "?"})`);
      } else {
        forget(id);
        log(`[P2P] peer disconnected ${id}`);
      }
      refreshCounts();
      break;
    }
    case "data": {
      const peer = typeof ev.peer === "string" ? peers.get(ev.peer) : undefined;
      if (!peer || typeof ev.b64 !== "string" || peer.rejected) break;
      try {
        peer.reassembler.push(Buffer.from(ev.b64, "base64"), (e) => onEnvelope(peer, e));
      } catch (err) {
        dropPeer(peer, `framing error: ${err instanceof Error ? err.message : err}`);
      }
      break;
    }
    case "error":
      log(`[P2P] helper error: ${ev.msg}`);
      break;
  }
}

function launch(): void {
  if (!state || state.stopped) return;
  const s = state;
  const spawnFn = s.opts.spawn ?? ((cmd, args) => nodeSpawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] }));
  let child: ChildProcess;
  try {
    child = spawnFn(s.helperPath, [s.name]);
  } catch (err) {
    log(`[P2P] helper spawn failed: ${err}`);
    scheduleRestart();
    return;
  }
  s.child = child;
  status.helperRunning = true;
  child.on("error", (err) => log(`[P2P] helper error: ${err.message}`));
  child.stdin?.on("error", () => { /* helper gone */ });
  child.stderr?.on("data", (d: Buffer) => log(`[P2P] helper: ${d.toString().trimEnd()}`));
  if (child.stdout) {
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (!line.trim()) return;
      try { onHelperEvent(JSON.parse(line)); }
      catch { log(`[P2P] bad helper line: ${line.slice(0, 120)}`); }
    });
  }
  child.on("exit", (code, sig) => {
    if (state?.child !== child) return;
    log(`[P2P] helper exited (code=${code} sig=${sig})`);
    state.child = null;
    status.helperRunning = false;
    status.advertising = false;
    for (const id of [...peers.keys()]) forget(id);
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

/** Start the P2P bridge if AIBROKER_P2P=1. Returns true when started. */
export function startP2pBridge(opts: P2pBridgeOptions = {}): boolean {
  const env = opts.env ?? process.env;
  if (env.AIBROKER_P2P !== "1") return false;
  const token = env.AIBROKER_P2P_TOKEN || env.AIBROKER_BLE_TOKEN;
  if (!token) { log("[P2P] AIBROKER_P2P_TOKEN (or AIBROKER_BLE_TOKEN) not set — P2P transport disabled"); return false; }
  if (state) stopP2pBridge();
  state = {
    opts, k0: deriveK0(token),
    name: env.AIBROKER_P2P_NAME || env.AIBROKER_BLE_NAME || DEFAULT_NAME,
    helperPath: resolveP2pHelperPath(env),
    child: null, stopped: false, restartTimer: null, attempt: 0,
  };
  status.enabled = true;
  status.authFailures = 0;
  setMqttOutTap(onOutbound, "p2p");
  log(`[P2P] starting helper ${state.helperPath}`);
  launch();
  return true;
}

export function stopP2pBridge(): void {
  if (!state) return;
  state.stopped = true;
  if (state.restartTimer) clearTimeout(state.restartTimer);
  helperSend({ cmd: "stop" });
  const child = state.child;
  if (child) setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 500).unref?.();
  setMqttOutTap(null, "p2p");
  for (const id of [...peers.keys()]) forget(id);
  retained.clear();
  state = null;
  Object.assign(status, { enabled: false, helperRunning: false, advertising: false, peers: 0, readyPeers: 0, authFailures: 0 });
}
