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
  private buf: Buffer = Buffer.alloc(0);
  /** Frames dropped because authentication failed. */
  authFailures = 0;
  /** Called with the raw body of every frame that failed authentication. */
  onAuthFailure?: (body: Buffer) => void;

  /** keyProvider is re-evaluated per frame (the key switches after hello within one push). */
  constructor(private keyProvider: () => Buffer | null = () => null) {}

  /**
   * Feed bytes; returns every envelope completed. `each` is invoked per envelope as soon as
   * it is decoded (before the next frame is decoded). Throws FrameTooLargeError (and resets) on oversize.
   */
  push(data: Buffer, each?: (env: BleEnvelope) => void): BleEnvelope[] {
    this.buf = this.buf.length === 0 ? Buffer.from(data) : Buffer.concat([this.buf, data]);
    const out: BleEnvelope[] = [];
    while (this.buf.length >= 4) {
      const n = this.buf.readUInt32BE(0);
      if (n > MAX_FRAME_BYTES) {
        this.reset();
        throw new FrameTooLargeError(n);
      }
      if (this.buf.length < 4 + n) break;
      let body = this.buf.subarray(4, 4 + n);
      this.buf = this.buf.subarray(4 + n);
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
    this.buf = Buffer.alloc(0);
  }
}
