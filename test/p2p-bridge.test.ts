import "./home-guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { startP2pBridge, stopP2pBridge, getP2pStatus, P2P_CHUNK } from "../src/adapters/pailot/p2p-bridge.js";
import { setMqttInboundHandler, mqttPublishStatus, mqttPublishText } from "../src/adapters/pailot/mqtt-broker.js";
import { encodeFrame, chunk, FrameReassembler } from "../src/adapters/pailot/ble-frame.js";
import { deriveK0, deriveKs } from "../src/adapters/pailot/ble-crypto.js";

const CN = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function fakeChild(): any {
  const child: any = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

function setup(extra: Record<string, unknown> = {}) {
  const child = fakeChild();
  const cmds: any[] = [];
  child.stdin.on("data", (d: Buffer) => {
    for (const l of d.toString().split("\n").filter(Boolean)) cmds.push(JSON.parse(l));
  });
  const ev = (o: object) => child.stdout.write(JSON.stringify(o) + "\n");
  const k0 = deriveK0("sekret");
  let key: Buffer | null = k0;
  let ks: Buffer | null = null;
  const re = new FrameReassembler(() => ks ?? k0);
  const all: any[] = [];
  let used = 0;
  const sent = () => {
    const out = cmds.filter((c) => c.cmd === "send");
    for (; used < out.length; used++) {
      for (const e of re.push(Buffer.from(out[used].b64, "base64"), (e) => {
        if (e.t === "ble/ready" && !ks) ks = deriveKs(k0, CN, Buffer.from((e.p as any).n, "hex"));
      })) all.push(e);
    }
    return all;
  };
  const app = (t: string, p: unknown, peer = "p1") => {
    for (const c of chunk(encodeFrame({ t, p }, key), P2P_CHUNK)) ev({ ev: "data", peer, b64: c.toString("base64") });
  };
  startP2pBridge({ env: { AIBROKER_P2P: "1", AIBROKER_P2P_TOKEN: "sekret" }, spawn: () => child, ...extra });
  ev({ ev: "ready" });
  ev({ ev: "advertising", name: "PAILot Hub" });
  ev({ ev: "peer", id: "p1", name: "iPhone", state: "connected" });
  return { cmds, ev, app, sent, useKs: () => { sent(); key = ks; }, hello: () => app("ble/hello", { app: "t", v: 2, n: CN.toString("hex") }) };
}

test("disabled without AIBROKER_P2P=1 or token", () => {
  assert.equal(startP2pBridge({ env: {} }), false);
  assert.equal(startP2pBridge({ env: { AIBROKER_P2P: "1" } }), false);
});

test("hello -> ready, ping/pong, inbound, outbound incl. large payload", async () => {
  const got: any[] = [];
  setMqttInboundHandler((s, type, payload) => got.push({ s, type, payload }));
  const h = setup();
  await tick();
  assert.equal(getP2pStatus().advertising, true);
  assert.equal(getP2pStatus().peers, 1);
  h.app("pailot/s1/in", { type: "text", msgId: "m0", content: "early" });
  await tick();
  assert.equal(got.length, 0, "ignored before hello");
  mqttPublishStatus("ready", "2");
  h.hello();
  await tick();
  assert.equal(getP2pStatus().readyPeers, 1);
  assert.equal(h.sent()[0].t, "ble/ready");
  h.useKs();
  h.app("ble/ping", {});
  await tick();
  assert.ok(h.sent().some((e) => e.t === "ble/pong"));
  h.app("pailot/s1/in", { type: "text", msgId: "m1", content: "hi" });
  await tick();
  assert.equal(got.length, 1);
  mqttPublishText("s1", "answer", "m2");
  mqttPublishText("s1", "x".repeat(200 * 1024), "m3"); // no size routing
  await tick();
  const out = h.sent().filter((e) => e.t === "pailot/out");
  assert.ok(out.some((e) => JSON.stringify(e.p).includes("answer")));
  assert.ok(out.some((e) => JSON.stringify(e.p).length > 200 * 1024));
  assert.ok(h.cmds.filter((c) => c.cmd === "send").length >= 4, "large frame split into 64 KiB chunks");
  stopP2pBridge();
  assert.equal(getP2pStatus().enabled, false);
});

test("wrong token gets the peer disconnected", async () => {
  const h = setup();
  const bad = Buffer.alloc(32);
  for (const c of chunk(encodeFrame({ t: "ble/hello", p: { v: 2, n: CN.toString("hex") } }, bad), 1000)) {
    h.ev({ ev: "data", peer: "p1", b64: c.toString("base64") });
  }
  await tick();
  assert.ok(h.cmds.some((c) => c.cmd === "disconnect" && c.peer === "p1"));
  assert.equal(getP2pStatus().readyPeers, 0);
  stopP2pBridge();
});

test("unauthenticated peer dropped after timeout", async () => {
  const h = setup({ authTimeoutMs: 40 });
  await tick(120);
  assert.ok(h.cmds.some((c) => c.cmd === "disconnect" && c.peer === "p1"));
  stopP2pBridge();
});

test("BLE and P2P taps coexist", async () => {
  const h = setup();
  h.hello(); await tick(); h.useKs();
  const { startBleBridge, stopBleBridge } = await import("../src/adapters/pailot/ble-bridge.js");
  assert.equal(startBleBridge({ env: { AIBROKER_BLE: "1", AIBROKER_BLE_TOKEN: "sekret" }, spawn: () => fakeChild() }), true);
  mqttPublishText("s1", "both", "m9");
  await tick();
  assert.ok(h.sent().some((e) => JSON.stringify(e.p).includes("both")));
  stopBleBridge();
  stopP2pBridge();
});

test("default auth timeout keeps a hello at 6s, drops silence at 16s", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const a = setup();
  t.mock.timers.tick(6000);
  a.hello();
  t.mock.timers.tick(1);
  assert.ok(!a.cmds.some((c) => c.cmd === "disconnect"));
  stopP2pBridge();
  const b = setup();
  t.mock.timers.tick(16000);
  assert.ok(b.cmds.some((c) => c.cmd === "disconnect" && c.peer === "p1"));
  stopP2pBridge();
});

test("AIBROKER_P2P_AUTH_TIMEOUT_MS overrides the default", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = setup();
  stopP2pBridge();
  const g = (() => {
    const c = setup({ env: { AIBROKER_P2P: "1", AIBROKER_P2P_TOKEN: "sekret", AIBROKER_P2P_AUTH_TIMEOUT_MS: "2000" } });
    return c;
  })();
  t.mock.timers.tick(2001);
  assert.ok(g.cmds.some((c) => c.cmd === "disconnect"));
  assert.ok(h);
  stopP2pBridge();
});
