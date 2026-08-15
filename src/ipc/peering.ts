/**
 * ipc/peering.ts — one hub talking to another, across machines.
 *
 * WHY PEERS AND NOT REMOTE CLIENTS. The obvious design is to let a session on
 * another machine dial this hub directly. It does not work: the hub finds
 * sessions by enumerating terminal panes on its own machine, and a pane on
 * another machine is not enumerable from here at all. So each machine runs its
 * own hub, which knows its own panes, and the hubs talk to each other. The
 * guest is then a first-class participant — its sessions appear in listings,
 * take messages and can be managed — rather than a special case threaded
 * through every call site.
 *
 * WHY THIS IS DANGEROUS AND WHAT IS DONE ABOUT IT. The local hub listens on a
 * unix socket, which is protected by file permissions and by not existing
 * anywhere else. This is a TCP port carrying commands that type into terminals
 * and drive screens. So:
 *
 *   - it is OFF unless configured. There is no default port.
 *   - it binds one named address. Never 0.0.0.0, which is refused outright
 *     rather than warned about, because a warning nobody reads is not a control.
 *   - every request must carry a shared secret, checked before dispatch. A
 *     connection that can reach the port is not thereby trusted.
 *   - the secret is generated, never chosen, and stored readable only by its
 *     owner.
 *
 * The intended network is a private overlay — a Tailscale address or a host-only
 * link to a virtual machine. It is not intended to face anything else, and the
 * bind check is what keeps that from being a matter of memory.
 */

import { connect } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { log } from "../core/log.js";

const CONFIG_FILE = join(homedir(), ".aibroker", "peering.json");

export interface PeerRecord {
  /** What a person calls it: "guest", "laptop". Used to address its sessions. */
  name: string;
  host: string;
  port: number;
  /** Shared secret. Presented on every call in both directions. */
  token: string;
  lastSeenAt?: number;
  lastError?: string;
}

export interface PeeringConfig {
  /** This hub's own listener. Absent means it accepts no peers. */
  listen?: { host: string; port: number; token: string };
  /** Hubs this one reaches out to. */
  peers: PeerRecord[];
}

function ensureDir(): void {
  const dir = join(homedir(), ".aibroker");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function loadPeering(): PeeringConfig {
  try {
    if (existsSync(CONFIG_FILE)) {
      const c = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as Partial<PeeringConfig>;
      return { listen: c.listen, peers: c.peers ?? [] };
    }
  } catch (e) {
    log(`[peer] config unreadable, treating as empty — ${(e as Error).message}`);
  }
  return { peers: [] };
}

export function savePeering(c: PeeringConfig): void {
  ensureDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(c, null, 2));
  // The file holds shared secrets. Anyone who can read it can type into these
  // machines' terminals, so the permission is part of the design and not tidiness.
  try { chmodSync(CONFIG_FILE, 0o600); } catch { /* best effort on odd filesystems */ }
}

export function newToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Compare secrets without leaking their contents through timing.
 *
 * Overkill for a home network and exactly the sort of thing that is never added
 * later. Lengths are compared first because timingSafeEqual throws on a
 * mismatch, and a thrown comparison is a failed comparison here.
 */
export function tokenMatches(given: unknown, expected: string): boolean {
  if (typeof given !== "string" || given.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  } catch {
    return false;
  }
}

/**
 * Addresses this hub may bind to.
 *
 * A wildcard bind is refused rather than discouraged. The port accepts commands
 * that drive a machine's screen and keyboard; "we meant to change that later"
 * is how such a thing ends up facing a café network. If someone genuinely wants
 * it wide they can say so with an explicit address of their own choosing.
 */
export function rejectWildcard(host: string): string | null {
  const wild = ["0.0.0.0", "::", "*", ""];
  if (wild.includes(host.trim())) {
    return (
      "refusing to bind a wildcard address. This port accepts commands that type into " +
      "terminals and drive the screen, so it must be bound to one named address — " +
      "a Tailscale address, or the host-only address of a virtual machine."
    );
  }
  return null;
}

/**
 * The single string that pairs two machines.
 *
 * Everything needed to connect, in one blob a person can copy once: where to
 * call, what secret to present, and what the other side calls itself. Pairing
 * that takes four fields typed into two machines is pairing that gets done
 * wrong at least once.
 */
export function makeInvite(name: string, host: string, port: number, token: string): string {
  return Buffer.from(JSON.stringify({ v: 1, name, host, port, token })).toString("base64");
}

export function readInvite(blob: string): { name: string; host: string; port: number; token: string } {
  const raw = JSON.parse(Buffer.from(blob.trim(), "base64").toString("utf8"));
  if (raw?.v !== 1 || !raw.host || !raw.port || !raw.token || !raw.name) {
    throw new Error("that invite is not readable — copy the whole line the other machine printed");
  }
  return { name: String(raw.name), host: String(raw.host), port: Number(raw.port), token: String(raw.token) };
}

/**
 * Call a method on a peer hub.
 *
 * Same NDJSON request/response as the local socket, so a handler cannot tell
 * where a call came from and does not need to. The token rides in the envelope
 * rather than a header because there is no header — the protocol is one line of
 * JSON, and adding a framing layer for one field would be its own bug surface.
 */
export function peerCall(
  peer: PeerRecord,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 12_000,
): Promise<{ ok: boolean; result?: any; error?: string }> {
  return new Promise((resolve) => {
    const sock = connect({ host: peer.host, port: peer.port });
    let buf = "";
    let settled = false;
    const done = (v: { ok: boolean; result?: any; error?: string }) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* already gone */ }
      resolve(v);
    };

    sock.on("connect", () => {
      sock.write(
        JSON.stringify({
          id: `peer-${Date.now()}`,
          sessionId: "peer",
          method,
          params,
          peerToken: peer.token,
        }) + "\n",
      );
    });
    sock.on("data", (d) => {
      buf += d.toString();
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      try {
        done(JSON.parse(buf.slice(0, nl)));
      } catch {
        done({ ok: false, error: "unreadable answer from peer" });
      }
    });
    sock.on("error", (e: NodeJS.ErrnoException) => {
      // Name the common causes rather than surfacing a bare code, because the
      // three that actually happen have three different fixes.
      const why =
        e.code === "ECONNREFUSED"
          ? "nothing is listening there — is the other machine's daemon running, and is peering switched on?"
          : e.code === "EHOSTUNREACH" || e.code === "ENETUNREACH"
            ? "no route to that address — check the network between the machines"
            : e.code === "ETIMEDOUT"
              ? "timed out reaching it"
              : (e.code ?? e.message);
      done({ ok: false, error: `${peer.name}: ${why}` });
    });
    setTimeout(() => done({ ok: false, error: `${peer.name}: no answer within ${Math.round(timeoutMs / 1000)}s` }), timeoutMs);
  });
}

/** Address a session as `peer/session`, so a name cannot be ambiguous across machines. */
export function splitRemote(target: string): { peer: string; session: string } | null {
  const i = target.indexOf("/");
  if (i <= 0 || i === target.length - 1) return null;
  return { peer: target.slice(0, i), session: target.slice(i + 1) };
}
