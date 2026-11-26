import "./home-guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { startBleBridge, stopBleBridge, getBleStatus, routeOutbound } from "../src/adapters/pailot/ble-bridge.js";
import { setMqttInboundHandler, mqttPublishStatus, mqttPublishText, mqttPublishImage, mqttPublishVoice } from "../src/adapters/pailot/mqtt-broker.js";
import { encodeFrame, chunk, FrameReassembler } from "../src/adapters/pailot/ble-frame.js";
import { deriveK0, deriveKs, readyMac } from "../src/adapters/pailot/ble-crypto.js";

const CN = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");

function setup(flow = false, extra: Record<string, unknown> = {}) {
  const child: any = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const cmds: any[] = [];
  child.stdin.on("data", (d: Buffer) => {
    for (const l of d.toString().split("\n").filter(Boolean)) cmds.push(JSON.parse(l));
  });
  const ev = (o: object) => child.stdout.write(JSON.stringify(o) + "\n");
  const k0 = deriveK0("sekret");
  let key: Buffer | null = k0; // key the fake app seals with
  let ks: Buffer | null = null;
  const appRaw = (frame: Buffer) => {
    for (const c of chunk(frame, 20)) ev({ ev: "rx", b64: c.toString("base64") });
  };
  const app = (t: string, p: unknown) => appRaw(encodeFrame({ t, p }, key));
  const sentRaw = new FrameReassembler(() => (ks ?? k0));
  let used = 0;
  const sent = () => {
    const txs = cmds.filter((c) => c.cmd === "tx");
    const out = [];
    for (; used < txs.length; used++) {
      for (const e of sentRaw.push(Buffer.from(txs[used].b64, "base64"), (e) => {
        if (e.t === "ble/ready" && !ks) ks = deriveKs(k0, CN, Buffer.from((e.p as any).n, "hex"));
      })) out.push(e);
    }
    all.push(...out);
    return all;
  };
  const all: any[] = [];
  const hello = (v = 2) => app("ble/hello", { app: "t", v, n: CN.toString("hex") });
  const useKs = () => { sent(); key = ks; };
  startBleBridge({
    env: { AIBROKER_BLE: "1", AIBROKER_BLE_TOKEN: "sekret" },
    spawn: () => child,
    ...extra,
  });
  ev(flow ? { ev: "ready", flow: 1 } : { ev: "ready" });
  ev({ ev: "central", connected: true, id: "c1" });
  ev({ ev: "mtu", n: 100 });
  return { child, cmds, ev, app, appRaw, sent, hello, useKs, k0, getKs: () => ks, setKey: (k: Buffer | null) => { key = k; }, reset: () => { ks = null; key = k0; } };
}
const tick = () => new Promise((r) => setTimeout(r, 30));

test("needs AIBROKER_BLE=1 and a token", () => {
  assert.equal(startBleBridge({ env: {} }), false);
  assert.equal(startBleBridge({ env: { AIBROKER_BLE: "1" } }), false);
});

test("hello ok -> ready, retained replay, ping/pong, inbound and outbound", async () => {
  mqttPublishStatus("ready", "1"); // no bridge yet: not retained in bridge
  const got: any[] = [];
  setMqttInboundHandler((s, type, payload) => got.push({ s, type, payload }));
  const h = setup();
  await tick();
  assert.deepEqual(h.cmds[0], { cmd: "start", name: "PAILot Hub", service: "7A1F0001-3C5B-4D2E-9A41-5041494C4F54" });
  h.app("pailot/s1/in", { type: "text", msgId: "m0", content: "early" });
  await tick();
  assert.equal(got.length, 0, "ignored before hello");
  mqttPublishStatus("ready", "2");
  h.hello();
  await tick();
  assert.equal(getBleStatus().ready, true);
  const sent = h.sent();
  assert.equal(sent[0].t, "ble/ready");
  const rp = sent[0].p as any;
  assert.equal(rp.v, 2);
  assert.equal(rp.mac, readyMac(h.getKs()!, CN, Buffer.from(rp.n, "hex")));
  assert.ok(!JSON.stringify(h.cmds).includes("sekret"));
  h.useKs();
  assert.ok(sent.some((e) => e.t === "pailot/status"), "retained state replayed");
  h.app("ble/ping", {});
  h.app("pailot/s1/in", { type: "text", msgId: "m1", content: "hi" });
  h.app("pailot/s1/in", { type: "voice", msgId: "m2", audioBase64: "AAAA" });
  await tick();
  assert.ok(h.sent().some((e) => e.t === "ble/pong"));
  assert.deepEqual(got.map((g) => g.type), ["text", "voice"]);
  assert.equal(got[0].s, "s1");
  assert.ok(h.cmds.filter((c) => c.cmd === "tx").every((c) => Buffer.from(c.b64, "base64").length <= 100));
  stopBleBridge();
});

test("wrong token -> drop and nothing delivered", async () => {
  const got: any[] = [];
  setMqttInboundHandler((s, type) => got.push(type));
  const h = setup();
  h.setKey(deriveK0("nope"));
  h.hello();
  h.app("pailot/s1/in", { type: "text", msgId: "m9", content: "x" });
  await tick();
  assert.equal(getBleStatus().ready, false);
  assert.ok(h.cmds.some((c) => c.cmd === "drop"));
  assert.equal(got.length, 0);
  assert.equal(h.sent().length, 0, "no ready sent");
  assert.ok(getBleStatus().authFailures >= 1);
  stopBleBridge();
});

test("v1 plaintext hello -> rejected, link dropped", async () => {
  const h = setup();
  h.setKey(null);
  h.app("ble/hello", { token: "sekret", app: "t" });
  await tick();
  assert.equal(getBleStatus().ready, false);
  assert.ok(h.cmds.some((c) => c.cmd === "drop"));
  assert.equal(h.sent().length, 0);
  stopBleBridge();
});

test("tampered frame after ready is dropped and counted; replay from old session rejected", async () => {
  const got: any[] = [];
  setMqttInboundHandler((s, type) => got.push(type));
  const h = setup();
  h.hello();
  await tick();
  h.useKs();
  const oldKs = h.getKs()!;
  const bad = Buffer.from(encodeFrame({ t: "pailot/s1/in", p: { type: "text", msgId: "t1", content: "x" } }, oldKs));
  bad[10] ^= 1;
  h.appRaw(bad);
  h.app("pailot/s1/in", { type: "text", msgId: "t2", content: "ok" });
  await tick();
  assert.equal(getBleStatus().ready, true);
  assert.equal(getBleStatus().authFailures, 1);
  assert.deepEqual(got, ["text"]);
  // new connection: a frame sealed with the old session key must not be accepted
  const replay = encodeFrame({ t: "pailot/s1/in", p: { type: "text", msgId: "t3", content: "again" } }, oldKs);
  h.reset();
  h.ev({ ev: "central", connected: false });
  h.ev({ ev: "central", connected: true, id: "c2" });
  h.hello();
  await tick();
  assert.equal(getBleStatus().ready, true);
  h.appRaw(replay);
  await tick();
  assert.equal(getBleStatus().authFailures, 2);
  assert.deepEqual(got, ["text"]);
  stopBleBridge();
});

// --- flow control / scheduler / liveness ---
const wait = (ms = 2) => new Promise((r) => setTimeout(r, ms));
const big = (n: number) => "x".repeat(n);

test("300KB hub->app with backpressure: in order, bounded in flight, pong overtakes queued bulk", async () => {
  const h = setup(true);
  await tick();
  h.hello();
  await tick();
  h.useKs();
  h.ev({ ev: "mtu", n: 512 });
  await tick();
  mqttPublishText("s1", big(300_000), "big1");
  mqttPublishText("s1", "after", "small2");
  await wait();
  const txs = () => h.cmds.filter((c) => c.cmd === "tx");
  let acked = 0, maxFlight = 0, ackedBytes = 0, pinged = false;
  for (let guard = 0; guard < 5000; guard++) {
    const t = txs();
    const sentBytes = t.reduce((a, c) => a + Buffer.from(c.b64, "base64").length, 0);
    maxFlight = Math.max(maxFlight, sentBytes - ackedBytes);
    if (acked === t.length && guard > 5 && t.length > 0 && sentBytes - ackedBytes === 0) break;
    for (let i = 0; i < 6 && acked < t.length; i++, acked++) {
      const n = Buffer.from(t[acked].b64, "base64").length;
      ackedBytes += n;
      h.ev({ ev: "sent", n });
    }
    if (!pinged && acked > 100) { h.app("ble/ping", {}); pinged = true; }
    await wait();
  }
  assert.ok(maxFlight <= 64 * 1024 + 512, `in flight ${maxFlight}`);
  assert.ok(txs().every((c) => Buffer.from(c.b64, "base64").length <= 512));
  const frames = h.sent().filter((e) => e.t !== "pailot/status" && e.t !== "ble/ready");
  assert.deepEqual(frames.map((e) => e.p?.msgId ?? e.t), ["big1", "ble/pong", "small2"]);
  assert.equal(frames[0].p.content.length, 300_000);
  assert.equal(getBleStatus().ready, true);
  stopBleBridge();
});

test("without flow:1 chunks are written immediately", async () => {
  const h = setup(false);
  h.hello();
  await tick();
  h.useKs();
  h.ev({ ev: "mtu", n: 512 });
  await tick();
  mqttPublishText("s1", big(200_000), "nf");
  await tick();
  assert.ok(h.cmds.filter((c) => c.cmd === "tx").length > 390);
  stopBleBridge();
});

test("300KB app->hub in 512B rx events: routed, link up, ping/pong around it; disconnect trace has counters", async () => {
  const got: any[] = [];
  setMqttInboundHandler((s, type, payload: any) => got.push({ type, len: payload?.content?.length }));
  const h = setup(true);
  await tick();
  h.hello();
  await tick();
  h.useKs();
  const ks = h.getKs()!;
  const lines: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  (process.stderr as any).write = (c: any) => { lines.push(String(c)); return true; };
  try {
    h.app("ble/ping", {});
    for (let k = 0; k < 2; k++) {
      const frame = encodeFrame({ t: "pailot/s1/in", p: { type: "text", msgId: "b" + k, content: big(300_000) } }, ks);
      for (const c of chunk(frame, 512)) h.ev({ ev: "rx", b64: c.toString("base64") });
      h.app("ble/ping", {});
      await wait(20);
    }
    // half a frame buffered at disconnect time
    const part = encodeFrame({ t: "pailot/s1/in", p: { type: "text", msgId: "p", content: big(5000) } }, ks);
    h.ev({ ev: "rx", b64: part.subarray(0, 1000).toString("base64") });
    await tick();
    assert.equal(getBleStatus().ready, true);
    assert.deepEqual(got.map((g) => g.len), [300_000, 300_000]);
    assert.equal(h.sent().filter((e) => e.t === "ble/pong").length, 3);
    h.ev({ ev: "central", connected: false, id: "c1" });
    await tick();
  } finally {
    (process.stderr as any).write = orig;
  }
  const line = lines.find((l) => l.includes("central disconnected"))!;
  assert.ok(line, "trace line present");
  assert.match(line, /after \d+s ready=true, rx=\d+B\/\d+fr, tx=\d+B\/\d+fr, pings=3, pongs=3, lastRx=[\d.]+s ago, rxPartial=996\/\d+B, txQueued=\d+B/);
  stopBleBridge();
});

test("idle: 5 pings over time each get a session-key pong immediately; link never dropped", async () => {
  const h = setup(true);
  await tick();
  h.hello();
  await tick();
  h.useKs();
  for (let i = 1; i <= 5; i++) {
    h.app("ble/ping", {});
    await tick();
    assert.equal(h.sent().filter((e) => e.t === "ble/pong").length, i);
  }
  assert.equal(getBleStatus().ready, true);
  assert.ok(!h.cmds.some((c) => c.cmd === "drop"));
  stopBleBridge();
});

test("coexistence: advertise events track connect state; low latency only around bulk, then high", async () => {
  const h = setup(true);
  h.ev({ ev: "advertising", name: "PAILot Hub" });
  assert.equal(getBleStatus().advertising, true);
  h.ev({ ev: "advertising", on: false }); // helper stops advertising on subscribe
  await tick();
  assert.equal(getBleStatus().advertising, false);
  h.hello();
  await tick();
  assert.equal(h.cmds.filter((c) => c.cmd === "latency").length, 0, "no latency request for idle/control traffic");
  mqttPublishText("s1", "x".repeat(20_000), "m1");
  await tick();
  assert.deepEqual(h.cmds.filter((c) => c.cmd === "latency"), [{ cmd: "latency", mode: "low" }]);
  // drain: helper acks everything
  const sentBytes = h.cmds.filter((c) => c.cmd === "tx").reduce((n, c) => n + Buffer.from(c.b64, "base64").length, 0);
  h.ev({ ev: "sent", n: sentBytes });
  await new Promise((r) => setTimeout(r, 1200));
  assert.deepEqual(h.cmds.filter((c) => c.cmd === "latency").map((c) => c.mode), ["low", "high"]);
  h.ev({ ev: "advertising", name: "PAILot Hub" }); // resumed after unsubscribe
  assert.equal(getBleStatus().advertising, true);
  stopBleBridge();
});

test("routeOutbound: size/type and mqtt availability", () => {
  const base = { size: 100, mqttAppClients: 1, bleReady: true };
  assert.deepEqual(routeOutbound({ ...base, type: "text" }), { ble: true, mqtt: true, large: false, reason: "small" });
  assert.equal(routeOutbound({ ...base, type: "image" }).ble, false);
  assert.equal(routeOutbound({ ...base, type: "screenshot" }).mqtt, true);
  const big = routeOutbound({ ...base, type: "voice", size: 70_000 });
  assert.equal(big.ble, false);
  assert.equal(big.mqtt, true);
  assert.equal(routeOutbound({ ...base, type: "voice", size: 70_000, maxPayload: 100_000 }).ble, true);
  const noMqtt = routeOutbound({ ...base, type: "image", mqttAppClients: 0 });
  assert.deepEqual([noMqtt.ble, noMqtt.mqtt], [true, false]);
  const noBle = routeOutbound({ ...base, type: "image", mqttAppClients: 0, bleReady: false });
  assert.deepEqual([noBle.ble, noBle.mqtt], [false, true]);
});

test("large image with MQTT client goes MQTT only (not on BLE)", async () => {
  const h = setup(false, { mqttAppClients: () => 1, downscaleImage: async () => { throw new Error("no"); } });
  h.hello(); await tick(); h.sent(); h.useKs();
  const n0 = h.cmds.filter((c) => c.cmd === "tx").length;
  mqttPublishImage("s1", "A".repeat(200_000), "cap", "img1");
  await tick();
  assert.equal(h.sent().filter((e) => e.p?.type === "image").length, 0);
  assert.equal(h.cmds.filter((c) => c.cmd === "tx").length, n0);
  stopBleBridge();
});

test("large image without MQTT client is downscaled and sent on BLE only", async () => {
  const calls: string[] = [];
  const h = setup(false, { mqttAppClients: () => 0, downscaleImage: async (b: string) => { calls.push(b); return "SMALLJPEG"; } });
  h.hello(); await tick(); h.sent(); h.useKs();
  mqttPublishImage("s1", "A".repeat(200_000), "cap", "img2");
  await tick();
  const imgs = h.sent().filter((e) => e.p?.type === "image");
  assert.equal(calls.length, 1);
  assert.equal(imgs.length, 1, "exactly one BLE copy");
  assert.equal(imgs[0].p.imageBase64, "SMALLJPEG");
  assert.equal(imgs[0].p.mimeType, "image/jpeg");
  stopBleBridge();
});

test("failed downscale drops; oversized voice after compress drops; small ok", async () => {
  const h = setup(false, {
    env: { AIBROKER_BLE: "1", AIBROKER_BLE_TOKEN: "sekret", AIBROKER_BLE_MAX_PAYLOAD: "50" },
    mqttAppClients: () => 0,
    downscaleImage: async () => null,
    compressAudio: async (b: string) => (b === "HUGE" ? "B".repeat(1_200_000) : "AAC"),
  });
  h.hello(); await tick(); h.sent(); h.useKs();
  mqttPublishImage("s1", "A".repeat(100), "c", "img3");
  mqttPublishVoice("s1", "HUGE", "t-".repeat(40), "v1");
  mqttPublishVoice("s1", "WAV", "t-".repeat(40), "v2");
  await tick();
  const out = h.sent();
  assert.equal(out.filter((e) => e.p?.type === "image").length, 0);
  assert.deepEqual(out.filter((e) => e.p?.type === "voice").map((e) => e.p.audioBase64), ["AAC"]);
  stopBleBridge();
});
