/**
 * daemon/peer-handlers.ts — pairing, and reaching sessions on another machine.
 *
 * The whole cross-machine surface is four verbs a person types once and then
 * forgets: invite, join, list, forget. Everything after that is ordinary — a
 * session on the guest appears in listings as `guest/<session>` and takes
 * messages like any other, because the alternative is every call site growing a
 * branch for "unless it is remote", and branches like that are never added
 * everywhere they are needed.
 */

import type { IpcServer } from "../ipc/server.js";
import { log } from "../core/log.js";
import {
  loadPeering,
  savePeering,
  newToken,
  makeInvite,
  readInvite,
  peerCall,
  rejectWildcard,
  splitRemote,
  type PeerRecord,
} from "../ipc/peering.js";

/**
 * Sessions on every paired hub, named `peer/session`.
 *
 * Best effort by design: a peer that is asleep, rebuilding or simply switched
 * off must not stop the local list being returned. An unreachable peer is
 * reported as unreachable rather than omitted, because a machine silently
 * missing from a list is indistinguishable from a machine with no sessions —
 * and those want opposite reactions.
 */
export async function remoteSessions(): Promise<{
  sessions: Array<Record<string, unknown>>;
  unreachable: Array<{ peer: string; why: string }>;
}> {
  const { peers } = loadPeering();
  const sessions: Array<Record<string, unknown>> = [];
  const unreachable: Array<{ peer: string; why: string }> = [];

  await Promise.all(
    peers.map(async (p) => {
      const r = await peerCall(p, "sessions", {});
      if (!r.ok) {
        unreachable.push({ peer: p.name, why: r.error ?? "unknown" });
        return;
      }
      for (const s of r.result?.sessions ?? []) {
        sessions.push({
          ...s,
          // Qualified on the way in, so nothing downstream has to know the
          // difference and two machines may hold a session of the same name.
          name: `${p.name}/${s.paiName ?? s.name}`,
          paiName: `${p.name}/${s.paiName ?? s.name}`,
          peer: p.name,
          remote: true,
        });
      }
    }),
  );

  return { sessions, unreachable };
}

/** Forward a call to whichever peer owns the addressed session. */
export async function forwardToPeer(
  target: string,
  method: string,
  params: Record<string, unknown>,
): Promise<{ ok: boolean; result?: any; error?: string } | null> {
  const split = splitRemote(target);
  if (!split) return null;
  const peer = loadPeering().peers.find((p) => p.name.toLowerCase() === split.peer.toLowerCase());
  if (!peer) return null;
  // The peer knows the session by its bare name; the prefix was ours.
  return peerCall(peer, method, { ...params, target: split.session, session: split.session });
}

export function registerPeerHandlers(server: IpcServer): void {
  /**
   * peer — the entire pairing surface.
   *
   * invite  on the machine that will be reached, prints one line to copy
   * join    on the other machine, paste that line
   * list    who is paired, and can each be reached right now
   * forget  remove one
   */
  server.on("peer", async (req) => {
    const { action, host, port, invite, name } = req.params as {
      action?: string;
      host?: string;
      port?: number;
      invite?: string;
      name?: string;
    };
    const cfg = loadPeering();

    switch (action) {
      case "invite": {
        if (!host) {
          return {
            ok: false,
            error:
              "an address is required: the one this machine should be reached on. " +
              "Use its Tailscale address, or the address the other machine sees it as. " +
              "There is deliberately no default — a guess here is a port open somewhere unintended.",
          };
        }
        const refusal = rejectWildcard(host);
        if (refusal) return { ok: false, error: refusal };

        // Reuse the existing secret if there is one, so inviting a second
        // machine does not silently lock out the first.
        const token = cfg.listen?.token ?? newToken();
        const p = port ?? cfg.listen?.port ?? 8770;
        cfg.listen = { host, port: p, token };
        savePeering(cfg);

        const me = name ?? "host";
        log(`[peer] invite issued for ${host}:${p} as "${me}" — listener starts on next daemon restart`);
        return {
          ok: true,
          result: {
            invite: makeInvite(me, host, p, token),
            message:
              `Paste this on the other machine:\n\n  aibroker peer join ${makeInvite(me, host, p, token)}\n\n` +
              `Then restart this daemon so the listener comes up on ${host}:${p}.\n` +
              `Anyone holding that line can type into this machine's terminals — treat it like a password.`,
          },
        };
      }

      case "join": {
        if (!invite) return { ok: false, error: "paste the whole line the other machine printed" };
        let inv;
        try {
          inv = readInvite(invite);
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
        const rec: PeerRecord = { name: inv.name, host: inv.host, port: inv.port, token: inv.token };

        // Prove it works now rather than at three in the morning. A pairing that
        // is only discovered to be broken when something depends on it is worse
        // than one that refuses at the moment somebody is watching.
        const probe = await peerCall(rec, "ping", {}, 8_000);
        if (!probe.ok) {
          return {
            ok: false,
            error:
              `paired nothing: ${probe.error}\n` +
              `The invite was readable, so the address or the listener is the problem. ` +
              `Check the other machine's daemon has been restarted since its invite was issued.`,
          };
        }

        cfg.peers = [...cfg.peers.filter((p) => p.name !== rec.name), { ...rec, lastSeenAt: Date.now() }];
        savePeering(cfg);
        log(`[peer] joined "${rec.name}" at ${rec.host}:${rec.port}`);
        return {
          ok: true,
          result: {
            message: `paired with "${rec.name}" and reached it. Its sessions appear as ${rec.name}/<name>.`,
          },
        };
      }

      case "list": {
        const rows = await Promise.all(
          cfg.peers.map(async (p) => {
            const r = await peerCall(p, "ping", {}, 6_000);
            return { name: p.name, address: `${p.host}:${p.port}`, reachable: r.ok, detail: r.ok ? "" : r.error };
          }),
        );
        return {
          ok: true,
          result: {
            listening: cfg.listen ? `${cfg.listen.host}:${cfg.listen.port}` : null,
            peers: rows,
          },
        };
      }

      case "forget": {
        if (!name) return { ok: false, error: "which one? give the peer's name" };
        const before = cfg.peers.length;
        cfg.peers = cfg.peers.filter((p) => p.name.toLowerCase() !== name.toLowerCase());
        savePeering(cfg);
        return {
          ok: true,
          result: { message: before === cfg.peers.length ? `no peer called "${name}"` : `forgot "${name}"` },
        };
      }

      default:
        return {
          ok: false,
          error: "peer <invite|join|list|forget>",
        };
    }
  });
}
