import "./home-guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveK0, deriveKs, readyMac, seal, open } from "../src/adapters/pailot/ble-crypto.js";
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

const hx = (h: string) => Buffer.from(h, "hex");
const VEC = {
  cn: hx("000102030405060708090a0b0c0d0e0f"), sn: hx("f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff"), fn: hx("a0a1a2a3a4a5a6a7a8a9aaab"),
  k0: "77ec02e405e5b43778c9441fbcb62a98c8a180dea4e1608ba54d268f57ed5aff",
  ks: "459e63f40ea4756cdd5d9cd3c8c9fcecd166fe80b89ee5c5b6a9c72aed573446",
  mac: "d26579a1e2cacea5c9d5094789b176264a992628d3215797dda6c2b4c5a17748",
  sealK0: "a0a1a2a3a4a5a6a7a8a9aaab9e717ad0bdfd8f815808156e565a528db5e3b8828eb8c8b51cf99440786f9a582e8e4f3ebcdc03",
  sealKs: "a0a1a2a3a4a5a6a7a8a9aaabc7feeb195ce7339f506070450fde2e83bd1a15140f2c80327c1d8a21157c1b71f594fd13c3eab3",
};
const PLAIN = Buffer.from('{"t":"ble/ping","p":{}}');

test("shared v2 vector: keys, mac, sealed values", () => {
  const k0 = deriveK0("pailot-test-token");
  const ks = deriveKs(k0, VEC.cn, VEC.sn);
  assert.equal(k0.toString("hex"), VEC.k0);
  assert.equal(ks.toString("hex"), VEC.ks);
  assert.equal(readyMac(ks, VEC.cn, VEC.sn), VEC.mac);
  assert.equal(seal(k0, PLAIN, VEC.fn).toString("hex"), VEC.sealK0);
  assert.equal(seal(ks, PLAIN, VEC.fn).toString("hex"), VEC.sealKs);
  assert.deepEqual(open(ks, hx(VEC.sealKs)), PLAIN);
  assert.deepEqual(encodeFrame(b, ks, VEC.fn).subarray(4), hx(VEC.sealKs));
});

test("sealed round-trip at every split; key switch mid-push; tamper dropped+counted", () => {
  const k0 = hx(VEC.k0), ks = hx(VEC.ks);
  const f = encodeFrame(a, ks);
  for (let i = 0; i <= f.length; i++) {
    const r = new FrameReassembler(() => ks);
    assert.deepEqual([...r.push(f.subarray(0, i)), ...r.push(f.subarray(i))], [a]);
  }
  let key = k0;
  const r = new FrameReassembler(() => key);
  const seen: string[] = [];
  const got = r.push(Buffer.concat([encodeFrame(b, k0), encodeFrame(a, ks)]), (e) => { seen.push(e.t); key = ks; });
  assert.deepEqual(got, [b, a]);
  assert.deepEqual(seen, ["ble/ping", "pailot/x/in"]);
  const bad = Buffer.from(encodeFrame(a, ks));
  bad[bad.length - 1] ^= 1;
  const r2 = new FrameReassembler(() => ks);
  assert.deepEqual(r2.push(Buffer.concat([bad, encodeFrame(b, ks)])), [b]);
  assert.equal(r2.authFailures, 1);
});
