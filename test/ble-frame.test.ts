import "./home-guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFrame, chunk, FrameReassembler, MAX_FRAME_BYTES } from "../src/adapters/pailot/ble-frame.js";

const a = { t: "pailot/x/in", p: { type: "text", content: "héllo ✓" } };
const b = { t: "ble/ping", p: {} };

test("split at every byte offset yields the envelope once", () => {
  const f = encodeFrame(a);
  for (let i = 0; i <= f.length; i++) {
    const r = new FrameReassembler();
    const got = [...r.push(f.subarray(0, i)), ...r.push(f.subarray(i))];
    assert.deepEqual(got, [a]);
  }
});

test("merged frames and 1-byte chunks", () => {
  const f = Buffer.concat([encodeFrame(a), encodeFrame(b)]);
  assert.deepEqual(new FrameReassembler().push(f), [a, b]);
  const r = new FrameReassembler();
  const got = chunk(f, 1).flatMap((c) => r.push(c));
  assert.deepEqual(got, [a, b]);
});

test("chunk caps at 512 and defaults to 20", () => {
  const big = Buffer.alloc(2000);
  assert.equal(chunk(big, 9999)[0].length, 512);
  assert.equal(chunk(big)[0].length, 20);
});

test("oversize length throws and resets", () => {
  const r = new FrameReassembler();
  const hdr = Buffer.alloc(4);
  hdr.writeUInt32BE(MAX_FRAME_BYTES + 1);
  assert.throws(() => r.push(hdr));
  assert.deepEqual(r.push(encodeFrame(b)), [b]);
});

test("bad json drops one frame only", () => {
  const body = Buffer.from("{nope");
  const hdr = Buffer.alloc(4);
  hdr.writeUInt32BE(body.length);
  const r = new FrameReassembler();
  assert.deepEqual(r.push(Buffer.concat([hdr, body, encodeFrame(a)])), [a]);
});
