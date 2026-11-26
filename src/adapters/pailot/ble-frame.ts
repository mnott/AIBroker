/**
 * adapters/pailot/ble-frame.ts — length-prefixed framing for the PAILot BLE link.
 *
 * frame = 4-byte big-endian length N + N bytes of UTF-8 JSON envelope {"t","p"}.
 * Pure functions, no I/O.
 */

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

export function encodeFrame(envelope: BleEnvelope): Buffer {
  const body = Buffer.from(JSON.stringify(envelope), "utf8");
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

  /** Feed bytes; returns every envelope completed. Throws FrameTooLargeError (and resets) on oversize. */
  push(data: Buffer): BleEnvelope[] {
    this.buf = this.buf.length === 0 ? Buffer.from(data) : Buffer.concat([this.buf, data]);
    const out: BleEnvelope[] = [];
    while (this.buf.length >= 4) {
      const n = this.buf.readUInt32BE(0);
      if (n > MAX_FRAME_BYTES) {
        this.reset();
        throw new FrameTooLargeError(n);
      }
      if (this.buf.length < 4 + n) break;
      const body = this.buf.subarray(4, 4 + n);
      this.buf = this.buf.subarray(4 + n);
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
        const env = JSON.parse(text);
        if (env && typeof env === "object" && typeof env.t === "string") {
          out.push({ t: env.t, p: env.p });
        }
      } catch {
        // corrupt frame: drop this one only
      }
    }
    return out;
  }

  reset(): void {
    this.buf = Buffer.alloc(0);
  }
}
