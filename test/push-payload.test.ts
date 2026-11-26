import "./home-guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { deriveKPush, pushAudioAuth, seal, open } from "../src/adapters/pailot/ble-crypto.js";
import { buildPushPayload, PUSH_BUDGET_BYTES, type PushMessage } from "../src/apns/client.js";
import { AudioCache, createPushAudioServer } from "../src/adapters/pailot/push-audio-server.js";

const TOKEN = "test-token";
const key = deriveKPush(TOKEN);
const msg = (o: Partial<PushMessage> = {}): PushMessage => ({
  msgId: "m1", seq: 7, sessionId: "s1", type: "text", content: "hello", sessionName: "PAI", ts: 1700000000000, ...o,
});
const decode = (b: ReturnType<typeof buildPushPayload>) =>
  JSON.parse(open(key, Buffer.from(b.custom.pl as string, "base64")).toString("utf8"));
const size = (b: ReturnType<typeof buildPushPayload>) => Buffer.byteLength(JSON.stringify({ aps: b.aps, ...b.custom }));

/*
 * Known-answer vectors (for the app implementer)
 *   token  = "test-token"
 *   pushKey = HKDF-SHA256(ikm=utf8(token), salt="pailot-push-v1-salt", info="pailot-push-v1", 32)
 *   nonce  = 000102030405060708090a0b
 *   plaintext = {"v":1,"msgId":"m1","seq":7,"sessionId":"s1","type":"text","content":"hello","sessionName":"PAI","ts":1700000000000}
 *   sealed base64 = see KAT_SEALED below
 *   X-PAILot-Auth (token "test-token", msgId "m1") = see KAT_AUTH below
 */
const KAT_PLAINTEXT = '{"v":1,"msgId":"m1","seq":7,"sessionId":"s1","type":"text","content":"hello","sessionName":"PAI","ts":1700000000000}';
const KAT_SEALED = "AAECAwQFBgcICQoLMdX6nxZi6eoea5Q5xT7G5dD52SymAznAEzBuKojve54M29ePGF/I7Yil1KDTt51Ue0Y036oo9RKp00UVsDp33wGxtfEUG05mnBEaum7Ddez/H9WF4aaPLVPA0JxEmfzGToobgvdBfGqqknJ7/QfghyIJDgu2PGfE7BFdwipXX/CP4s08";
const KAT_AUTH = "a62a9dfc3dfe0afc2adc80a4707b30af8eb22ea97e2d21b52debea9513983964";

test("known-answer vectors", () => {
  const nonce = Buffer.from("000102030405060708090a0b", "hex");
  const sealed = seal(key, Buffer.from(KAT_PLAINTEXT), nonce).toString("base64");
  const auth = pushAudioAuth(key, "m1");
  console.log(`KAT key=${key.toString("hex")}\nKAT sealed=${sealed}\nKAT auth=${auth}`);
  assert.equal(sealed, KAT_SEALED);
  assert.equal(auth, KAT_AUTH);
  const b = buildPushPayload({ title: "PAI", body: "hello", message: msg(), token: TOKEN, nonce });
  assert.equal(b.custom.pl, KAT_SEALED);
});

test("short text: full push decrypts back", () => {
  const b = buildPushPayload({ title: "PAI", body: "hello", message: msg(), token: TOKEN });
  assert.equal(b.mode, "full");
  assert.equal(b.custom.plv, 1);
  assert.equal(b.custom.sessionId, "s1");
  assert.equal(b.aps["mutable-content"], 1);
  assert.equal(b.aps["thread-id"], "s1");
  const pl = decode(b);
  assert.equal(pl.content, "hello");
  assert.equal(pl.v, 1);
  assert.equal(pl.msgId, "m1");
  assert.equal(pl.ref, undefined);
});

test("oversized text falls back to ref without content", () => {
  const b = buildPushPayload({ title: "PAI", body: "x", message: msg({ content: "a".repeat(5000) }), token: TOKEN });
  assert.equal(b.mode, "ref");
  const pl = decode(b);
  assert.equal(pl.ref, true);
  assert.equal("content" in pl, false);
  assert.equal(b.aps["mutable-content"], 1);
  assert.ok(size(b) < 4096);
});

test("voice uses transcript; ref keeps audio fields", () => {
  const audio = { audioPath: "/pailot/audio/m1", audioPort: 8099, audioSecs: 12.5 };
  const b = buildPushPayload({ title: "PAI", body: "t", message: msg({ type: "voice", content: "transcript", ...audio }), token: TOKEN });
  const pl = decode(b);
  assert.equal(pl.type, "voice");
  assert.equal(pl.content, "transcript");
  assert.equal(pl.audioPath, "/pailot/audio/m1");
  const r = buildPushPayload({ title: "PAI", body: "t", message: msg({ type: "voice", content: "z".repeat(6000), ...audio }), token: TOKEN });
  const rp = decode(r);
  assert.equal(r.mode, "ref");
  assert.equal(rp.audioPort, 8099);
  assert.equal("content" in rp, false);
});

test("audio fields absent when not supplied", () => {
  const pl = decode(buildPushPayload({ title: "a", body: "b", message: msg({ type: "voice" }), token: TOKEN }));
  assert.equal("audioPath" in pl, false);
  assert.equal("audioPort" in pl, false);
});

test("image is reference-only", () => {
  const b = buildPushPayload({ title: "a", body: "b", message: msg({ type: "image", content: undefined }), token: TOKEN });
  assert.equal(b.mode, "ref");
  assert.equal(decode(b).ref, true);
});

test("no token: plain payload, no pl", () => {
  const b = buildPushPayload({ title: "PAI", body: "hello", message: msg(), data: { sessionId: "s1" } });
  assert.equal(b.mode, "plain");
  assert.equal("pl" in b.custom, false);
  assert.equal("mutable-content" in b.aps, false);
  assert.deepEqual(b.aps, { alert: { title: "PAI", body: "hello" }, badge: 1, sound: "default" });
});

test("byte size never exceeds 4096 incl. multibyte", () => {
  for (const unit of ["😀", "漢", "é", "a"]) {
    for (const n of [1, 100, 500, 900, 950, 1000, 1200, 1300, 2000, 5000]) {
      const content = unit.repeat(n);
      const b = buildPushPayload({ title: "PAI", body: content.slice(0, 100), message: msg({ content }), token: TOKEN });
      assert.ok(size(b) <= PUSH_BUDGET_BYTES, `${unit}x${n} ${size(b)}`);
      assert.equal(b.bytes, size(b));
      if (b.mode === "full") assert.equal(decode(b).content, content);
    }
  }
});

test("AudioCache: TTL, entry cap, byte cap", () => {
  let t = 0;
  const c = new AudioCache({ ttlMs: 1000, maxEntries: 3, maxBytes: 10, now: () => t });
  c.put("a", Buffer.alloc(4));
  t = 500;
  c.put("b", Buffer.alloc(4));
  assert.ok(c.get("a"));
  t = 1200;
  assert.equal(c.get("a"), undefined); // expired
  assert.ok(c.get("b"));
  c.put("c", Buffer.alloc(4)); // 8 bytes
  c.put("d", Buffer.alloc(4)); // 12 > 10: evict oldest (b)
  assert.equal(c.get("b"), undefined);
  assert.ok(c.get("c") && c.get("d"));
  assert.equal(c.put("big", Buffer.alloc(11)), false);
  const e = new AudioCache({ maxEntries: 2 });
  e.put("1", Buffer.alloc(1)); e.put("2", Buffer.alloc(1)); e.put("3", Buffer.alloc(1));
  assert.equal(e.get("1"), undefined);
  assert.equal(e.size, 2);
});

test("audio server: auth accept/reject, sealed body, 404 after expiry", async () => {
  let t = 0;
  const cache = new AudioCache({ ttlMs: 1000, now: () => t });
  const bytes = Buffer.from("fake-m4a-bytes");
  cache.put("m1", bytes);
  const srv = createPushAudioServer(cache, key);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    const ok = await fetch(`${base}/pailot/audio/m1`, { headers: { "X-PAILot-Auth": pushAudioAuth(key, "m1") } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "application/octet-stream");
    assert.deepEqual(open(key, Buffer.from(await ok.arrayBuffer())), bytes);
    assert.equal((await fetch(`${base}/pailot/audio/m1`, { headers: { "X-PAILot-Auth": "00" } })).status, 401);
    assert.equal((await fetch(`${base}/pailot/audio/m1`)).status, 401);
    assert.equal((await fetch(`${base}/pailot/audio/m1`, { headers: { "X-PAILot-Auth": pushAudioAuth(key, "other") } })).status, 401);
    assert.equal((await fetch(`${base}/pailot/audio/nope`, { headers: { "X-PAILot-Auth": pushAudioAuth(key, "nope") } })).status, 404);
    t = 2000;
    assert.equal((await fetch(`${base}/pailot/audio/m1`, { headers: { "X-PAILot-Auth": pushAudioAuth(key, "m1") } })).status, 404);
  } finally {
    srv.close();
  }
});

test("push audio disabled by default", async () => {
  const m = await import("../src/adapters/pailot/push-audio-server.js");
  assert.equal(m.startPushAudioServer({ AIBROKER_BLE_TOKEN: TOKEN }), false);
  assert.equal(m.isPushAudioEnabled(), false);
  assert.equal(m.cachePushAudio("m1", Buffer.alloc(1)), false);
});

test("catch_up keeps the push msgId for text and for voice (downgraded to text)", async () => {
  const { buildCatchUp } = await import("../src/adapters/pailot/gateway.js");
  const missed = [
    { payload: { msgId: "push-voice", seq: 2, type: "voice", sessionId: "s1", audioBase64: "AAAA", transcript: "hi" } },
    { payload: { msgId: "push-text", seq: 1, type: "text", sessionId: "s1", content: "hello" } },
  ];
  const { messages } = buildCatchUp(missed);
  const ids = messages.map((m) => m.msgId).sort();
  assert.deepEqual(ids, ["push-text", "push-voice"]);
});

test("audio server logs every request (200, 401, 404) without the auth value", async () => {
  const cache = new AudioCache();
  cache.put("m1", Buffer.from("x"));
  const srv = createPushAudioServer(cache, key);
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const lines: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((c: string | Uint8Array) => { lines.push(String(c)); return true; }) as typeof process.stderr.write;
  const auth = pushAudioAuth(key, "m1");
  try {
    await fetch(`${base}/pailot/audio/m1`, { headers: { "X-PAILot-Auth": auth } });
    await fetch(`${base}/pailot/audio/m1`, { headers: { "X-PAILot-Auth": "00" } });
    await fetch(`${base}/pailot/audio/miss`, { headers: { "X-PAILot-Auth": pushAudioAuth(key, "miss") } });
    await fetch(`${base}/other`);
  } finally {
    process.stderr.write = orig;
    srv.close();
  }
  const out = lines.join("");
  assert.match(out, /\[PushAudio\] GET \/pailot\/audio\/m1 from \S+ -> 200 \d+/);
  assert.match(out, /GET \/pailot\/audio\/m1 from \S+ -> 401 0/);
  assert.match(out, /GET \/pailot\/audio\/miss from \S+ -> 404 0/);
  assert.match(out, /GET \/other from \S+ -> 404 0/);
  assert.equal(out.includes(auth), false);
});

test("voice push with audio fields is full and carries audioPath/audioPort/msgId", () => {
  const b = buildPushPayload({ title: "PAI", body: "t", token: TOKEN,
    message: msg({ type: "voice", content: "hi", audioPath: "/pailot/audio/m1", audioPort: 8099, audioSecs: 3.2 }) });
  assert.equal(b.mode, "full");
  const pl = decode(b);
  assert.equal(pl.audioPath, "/pailot/audio/m1");
  assert.equal(pl.audioPort, 8099);
  assert.equal(pl.msgId, "m1");
});
