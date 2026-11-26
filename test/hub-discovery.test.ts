import { test } from "node:test";
import assert from "node:assert/strict";
import {
  listLocalAddresses, startAdvertising, stopAdvertising, watchAddresses, type LocalAddress,
} from "../src/adapters/pailot/hub-discovery.js";
import { buildStatusPayload } from "../src/adapters/pailot/mqtt-broker.js";

const ifaces: any = {
  lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
  en0: [
    { address: "172.20.10.11", family: "IPv4", internal: false },
    { address: "fe80::1", family: "IPv6", internal: false },
  ],
  en1: [{ address: "192.168.1.5", family: "IPv4", internal: false }],
  utun0: [{ address: "10.0.0.1", family: "IPv4", internal: true }],
};

test("listLocalAddresses filters loopback/internal/IPv6, keeps hotspot", () => {
  assert.deepEqual(listLocalAddresses(ifaces), [
    { iface: "en0", ip: "172.20.10.11" },
    { iface: "en1", ip: "192.168.1.5" },
  ]);
});

test("advertise publishes mqtt with TXT; stop calls stop+destroy", () => {
  let published: any; let stopped = 0; let destroyed = 0;
  const factory = () => ({
    publish: (o: any) => { published = o; return { stop: () => { stopped++; } }; },
    destroy: () => { destroyed++; },
  });
  startAdvertising({ port: 8765, tls: true, version: "1.2.3", hubId: "hub1" }, factory);
  assert.equal(published.type, "mqtt");
  assert.equal(published.name, "AIBroker");
  assert.equal(published.port, 8765);
  assert.deepEqual(published.txt, { hub: "hub1", proto: "1", tls: "1", v: "1.2.3" });
  stopAdvertising();
  assert.equal(stopped, 1);
  assert.equal(destroyed, 1);
});

test("watcher fires only on change", async () => {
  let cur: LocalAddress[] = [{ iface: "en0", ip: "1.1.1.1" }];
  const seen: LocalAddress[][] = [];
  const stop = watchAddresses((a) => seen.push(a), () => cur, 10);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(seen.length, 0);
  cur = [{ iface: "en0", ip: "172.20.10.11" }];
  await new Promise((r) => setTimeout(r, 40));
  stop();
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0].ip, "172.20.10.11");
});

test("status payload carries addresses, port, tls, hubId", () => {
  const p = buildStatusPayload("ready", "1.0") as any;
  assert.ok(Array.isArray(p.addresses));
  assert.equal(typeof p.port, "number");
  assert.equal(typeof p.tls, "boolean");
  assert.equal(typeof p.hubId, "string");
});
