/**
 * adapters/pailot/push-audio-server.ts — serves voice-reply audio to the iOS
 * Notification Service Extension so a voice push can be audible in background.
 *
 * GET /pailot/audio/<msgId> with header X-PAILot-Auth = pushAudioAuth(pushKey, msgId).
 * Body = seal(pushKey, m4aBytes), so plain HTTP over LAN/Tailscale leaks nothing.
 * Env: PAILOT_PUSH_AUDIO_PORT (default 0 = disabled), PAILOT_PUSH_AUDIO_BIND (default 0.0.0.0).
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { log } from "../../core/log.js";
import { deriveKPush, pushAudioAuth, macEquals, seal } from "./ble-crypto.js";

export interface AudioCacheOpts { ttlMs?: number; maxEntries?: number; maxBytes?: number; now?: () => number }

/** In-memory m4a cache: TTL, entry cap and total byte cap; evicts oldest first. */
export class AudioCache {
  private m = new Map<string, { bytes: Buffer; at: number }>();
  private ttlMs: number;
  private maxEntries: number;
  private maxBytes: number;
  private now: () => number;
  constructor(o: AudioCacheOpts = {}) {
    this.ttlMs = o.ttlMs ?? 10 * 60_000;
    this.maxEntries = o.maxEntries ?? 20;
    this.maxBytes = o.maxBytes ?? 40 * 1024 * 1024;
    this.now = o.now ?? Date.now;
  }
  private total(): number { let t = 0; for (const e of this.m.values()) t += e.bytes.length; return t; }
  private expire(): void {
    const t = this.now();
    for (const [k, e] of this.m) if (t - e.at > this.ttlMs) this.m.delete(k);
  }
  /** Returns false when a single entry exceeds the byte cap. */
  put(msgId: string, bytes: Buffer): boolean {
    if (bytes.length > this.maxBytes) return false;
    this.expire();
    this.m.delete(msgId);
    this.m.set(msgId, { bytes, at: this.now() });
    while (this.m.size > this.maxEntries || this.total() > this.maxBytes) {
      const oldest = this.m.keys().next().value as string;
      this.m.delete(oldest);
    }
    return true;
  }
  get(msgId: string): Buffer | undefined {
    this.expire();
    return this.m.get(msgId)?.bytes;
  }
  get size(): number { this.expire(); return this.m.size; }
}

export function createPushAudioServer(cache: AudioCache, pushKey: Buffer): Server {
  return createServer((req, res) => {
    const m = /^\/pailot\/audio\/([^/?#]+)$/.exec(req.url ?? "");
    if (req.method !== "GET" || !m) { res.writeHead(404).end(); return; }
    let msgId: string;
    try { msgId = decodeURIComponent(m[1]); } catch { res.writeHead(404).end(); return; }
    const hdr = req.headers["x-pailot-auth"];
    if (typeof hdr !== "string" || !macEquals(hdr, pushAudioAuth(pushKey, msgId))) { res.writeHead(401).end(); return; }
    const bytes = cache.get(msgId);
    if (!bytes) { res.writeHead(404).end(); return; }
    const body = seal(pushKey, bytes);
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": body.length }).end(body);
  });
}

// --- module singleton wired to env ---
const cache = new AudioCache();
let server: Server | null = null;
let activePort = 0;

export function isPushAudioEnabled(): boolean { return server !== null && activePort > 0; }
export function getPushAudioPort(): number { return activePort; }

/** Cache m4a bytes for a voice push. No-op (false) when the server is disabled. */
export function cachePushAudio(msgId: string, m4a: Buffer): boolean {
  return isPushAudioEnabled() ? cache.put(msgId, m4a) : false;
}

export function startPushAudioServer(env: NodeJS.ProcessEnv = process.env): boolean {
  const port = Number(env.PAILOT_PUSH_AUDIO_PORT ?? 0);
  const token = env.AIBROKER_BLE_TOKEN;
  if (!Number.isInteger(port) || port <= 0) { log("[PushAudio] PAILOT_PUSH_AUDIO_PORT not set — push audio disabled"); return false; }
  if (!token) { log("[PushAudio] AIBROKER_BLE_TOKEN not set — push audio disabled"); return false; }
  if (server) return true;
  const s = createPushAudioServer(cache, deriveKPush(token));
  s.on("error", (e) => { log(`[PushAudio] server error: ${e.message}`); if (server === s) { server = null; activePort = 0; } });
  s.listen(port, env.PAILOT_PUSH_AUDIO_BIND || "0.0.0.0", () => {
    activePort = (s.address() as AddressInfo).port;
    log(`[PushAudio] listening on ${env.PAILOT_PUSH_AUDIO_BIND || "0.0.0.0"}:${activePort}`);
  });
  server = s;
  activePort = port;
  return true;
}

export function stopPushAudioServer(): void {
  server?.close();
  server = null;
  activePort = 0;
}
