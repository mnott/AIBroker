/**
 * adapters/pailot/hub-discovery.ts — LAN discovery of the hub for the PAILot app.
 *
 * Bonjour `_mqtt._tcp` advertisement (with TXT records), local IPv4 address
 * listing, and a watcher that fires when the address set changes.
 */

import os from "node:os";
import { createRequire } from "node:module";
import { log } from "../../core/log.js";

const require = createRequire(import.meta.url);

export interface LocalAddress { iface: string; ip: string }
export type IfaceMap = ReturnType<typeof os.networkInterfaces>;

export interface AdvertiseOpts { port: number; tls: boolean; version: string; hubId: string }

/** Minimal bonjour-service surface we use. */
export interface BonjourLike {
  publish(opts: Record<string, unknown>): { stop?: (cb?: () => void) => void } | any;
  destroy(): void;
}
export type BonjourFactory = () => BonjourLike;

const defaultFactory: BonjourFactory = () => {
  const { Bonjour } = require("bonjour-service");
  return new Bonjour();
};

/** Non-loopback, non-internal IPv4 addresses per interface. */
export function listLocalAddresses(ifaces: IfaceMap = os.networkInterfaces()): LocalAddress[] {
  const out: LocalAddress[] = [];
  for (const [iface, infos] of Object.entries(ifaces)) {
    for (const info of infos ?? []) {
      const fam = (info as { family: string | number }).family;
      if (fam !== "IPv4" && fam !== 4) continue;
      if (info.internal || info.address.startsWith("127.")) continue;
      out.push({ iface, ip: info.address });
    }
  }
  return out;
}

export function addressKey(addrs: LocalAddress[]): string {
  return addrs.map((a) => `${a.iface}=${a.ip}`).sort().join(",");
}

let instance: BonjourLike | null = null;
let service: any = null;
let lastOpts: AdvertiseOpts | null = null;

export function startAdvertising(opts: AdvertiseOpts, factory: BonjourFactory = defaultFactory): void {
  stopAdvertising();
  try {
    instance = factory();
    service = instance.publish({
      name: "AIBroker",
      type: "mqtt",
      port: opts.port,
      txt: { hub: opts.hubId, proto: "1", tls: opts.tls ? "1" : "0", v: opts.version },
    });
    lastOpts = opts;
    log(`[MQTT] Bonjour advertising _mqtt._tcp on port ${opts.port}`);
  } catch (err) {
    log(`[MQTT] Bonjour advertising failed (non-fatal): ${err instanceof Error ? err.message : err}`);
  }
}

export function stopAdvertising(): void {
  if (service) {
    try { service.stop?.(); } catch { /* ignore */ }
    service = null;
  }
  if (instance) {
    try { instance.destroy(); } catch { /* ignore */ }
    instance = null;
  }
}

/** Re-announce with the last options (stop + republish). */
export function reannounce(factory: BonjourFactory = defaultFactory): void {
  if (lastOpts) startAdvertising(lastOpts, factory);
}

/**
 * Poll the interface set; call onChange(addresses) only when it changed.
 * Returns a stop function. The timer is unref'd.
 */
export function watchAddresses(
  onChange: (addrs: LocalAddress[]) => void,
  provider: () => LocalAddress[] = () => listLocalAddresses(),
  intervalMs = 15_000,
): () => void {
  let last = addressKey(provider());
  const timer = setInterval(() => {
    const cur = provider();
    const key = addressKey(cur);
    if (key !== last) {
      last = key;
      try { onChange(cur); } catch (err) {
        log(`[MQTT] address watcher callback failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
