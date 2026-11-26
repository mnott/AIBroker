import "./home-guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { startBleBridge, stopBleBridge, getBleStatus } from "../src/adapters/pailot/ble-bridge.js";
import { setMqttInboundHandler, mqttPublishStatus } from "../src/adapters/pailot/mqtt-broker.js";
import { encodeFrame, chunk, FrameReassembler } from "../src/adapters/pailot/ble-frame.js";

function setup() {
  const child: any = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const cmds: any[] = [];
  child.stdin.on("data", (d: Buffer) => {
    for (const l of d.toString().split("\n").filter(Boolean)) cmds.push(JSON.parse(l));
  });
  const ev = (o: object) => child.stdout.write(JSON.stringify(o) + "\n");
  const app = (t: string, p: unknown) => {
    for (const c of chunk(encodeFrame({ t, p }), 20)) ev({ ev: "rx", b64: c.toString("base64") });
  };
  const sent = () => {
    const r = new FrameReassembler();
    return cmds.filter((c) => c.cmd === "tx").flatMap((c) => r.push(Buffer.from(c.b64, "base64")));
  };
  startBleBridge({
    env: { AIBROKER_BLE: "1", AIBROKER_BLE_TOKEN: "sekret" },
    spawn: () => child,
  });
  ev({ ev: "ready" });
  ev({ ev: "central", connected: true, id: "c1" });
  ev({ ev: "mtu", n: 100 });
  return { child, cmds, ev, app, sent };
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
  h.app("ble/hello", { token: "sekret", app: "t" });
  await tick();
  assert.equal(getBleStatus().ready, true);
  const sent = h.sent();
  assert.equal(sent[0].t, "ble/ready");
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
  h.app("ble/hello", { token: "nope" });
  h.app("pailot/s1/in", { type: "text", msgId: "m9", content: "x" });
  await tick();
  assert.equal(getBleStatus().ready, false);
  assert.ok(h.cmds.some((c) => c.cmd === "drop"));
  assert.equal(got.length, 0);
  stopBleBridge();
});
