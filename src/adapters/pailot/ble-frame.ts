/**
 * adapters/pailot/ble-frame.ts — length-prefixed framing for the PAILot BLE link.
 *
 * frame = 4-byte big-endian length N + N bytes of body. Body = UTF-8 JSON envelope
 * {"t","p"} (no key) or, in protocol v2, nonce||AES-256-GCM||tag sealing that JSON.
 * Pure functions, no I/O.
 */

import { open, seal } from "./ble-crypto.js";

export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const DEFAULT_CHUNK = 20;
export const MAX_CHUNK = 512;

export interface BleEnvelope {
  t: string;
  p: unknown;
}

export class FrameTooLargeError extends Error {
  constructor(n: number) {
    super(`BLE frame too large: ${n} bytes (max ${MAX_FRAME_BYTES})`);
    this.name = "FrameTooLargeError";
  }
}

export function encodeFrame(envelope: BleEnvelope, key?: Buffer | null, nonce?: Buffer): Buffer {
  const plain = Buffer.from(JSON.stringify(envelope), "utf8");
  const body = key ? seal(key, plain, nonce) : plain;
  if (body.length > MAX_FRAME_BYTES) throw new FrameTooLargeError(body.length);
  const out = Buffer.allocUnsafe(4 + body.length);
  out.writeUInt32BE(body.length, 0);
  body.copy(out, 4);
  return out;
}

export function chunk(buf: Buffer, size: number = DEFAULT_CHUNK): Buffer[] {
  const n = Math.max(1, Math.min(MAX_CHUNK, Math.floor(size) || DEFAULT_CHUNK));
  const out: Buffer[] = [];
  for (let i = 0; i < buf.length; i += n) out.push(buf.subarray(i, i + n));
  return out;
}

/** Streaming reassembler: accepts arbitrary splits/merges of the frame stream. */
export class FrameReassembler {
  /** Pending chunks not yet consumed (concatenated only when a frame is complete). */
  private chunks: Buffer[] = [];
  private len = 0;
  /** Declared body length of the frame being assembled, -1 until the 4-byte header is known. */
  private declared = -1;
  /** Frames dropped because authentication failed. */
  authFailures = 0;
  /** Called with the raw body of every frame that failed authentication. */
  onAuthFailure?: (body: Buffer) => void;

  /** keyProvider is re-evaluated per frame (the key switches after hello within one push). */
  constructor(private keyProvider: () => Buffer | null = () => null) {}

  /** Bytes buffered of the partially received frame (header included). */
  get pendingBytes(): number { return this.len; }
  /** Declared body length of the partial frame, 0 when unknown/none. */
  get expectedBytes(): number { return this.declared >= 0 ? this.declared : 0; }

  private take(n: number): Buffer {
    const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.len);
    const out = all.subarray(0, n);
    const rest = all.subarray(n);
    this.chunks = rest.length ? [rest] : [];
    this.len = rest.length;
    return out;
  }

  /**
   * Feed bytes; returns every envelope completed. `each` is invoked per envelope as soon as
   * it is decoded (before the next frame is decoded). Throws FrameTooLargeError (and resets) on oversize.
   */
  push(data: Buffer, each?: (env: BleEnvelope) => void): BleEnvelope[] {
    if (data.length) { this.chunks.push(Buffer.from(data)); this.len += data.length; }
    const out: BleEnvelope[] = [];
    for (;;) {
      if (this.declared < 0) {
        if (this.len < 4) break;
        const n = this.take(4).readUInt32BE(0);
        // take() above consumed the header; keep it simple by tracking declared separately
        if (n > MAX_FRAME_BYTES) {
          this.reset();
          throw new FrameTooLargeError(n);
        }
        this.declared = n;
      }
      if (this.len < this.declared) break;
      let body = this.take(this.declared);
      this.declared = -1;
      const key = this.keyProvider();
      if (key) {
        try { body = open(key, body); }
        catch { this.authFailures++; this.onAuthFailure?.(body); continue; }
      }
      let env: BleEnvelope | null = null;
      try {
        const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
        if (parsed && typeof parsed === "object" && typeof parsed.t === "string") env = { t: parsed.t, p: parsed.p };
      } catch {
        // corrupt frame: drop this one only
      }
      if (env) {
        out.push(env);
        each?.(env);
      }
    }
    return out;
  }

  reset(): void {
    this.chunks = [];
    this.len = 0;
    this.declared = -1;
  }
}
