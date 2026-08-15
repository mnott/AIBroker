/**
 * daemon/peer-cli.ts — pairing machines, and seeing the fleet.
 *
 * Two commands to pair, one to look. Pairing that takes four values typed into
 * two machines gets done wrong at least once, and the wrong one is usually the
 * secret, which fails in a way that looks like a network problem.
 */

import { WatcherClient } from "../ipc/client.js";
import { DAEMON_SOCKET_PATH } from "./index.js";

function client(): WatcherClient {
  return new WatcherClient(DAEMON_SOCKET_PATH);
}

/**
 * Call the local daemon, and distinguish "it is not there" from "it said no".
 *
 * The first version reported every failure as "the local daemon did not
 * answer", so a deliberate refusal — refusing to bind a wildcard address, for
 * instance — was presented as the daemon being down. That sends the reader to
 * check whether the service is running when the service is working correctly
 * and telling them something important. A transport failure and a considered
 * answer are different events and must not share a sentence.
 */
async function call(method: string, params: Record<string, unknown>): Promise<any> {
  try {
    return await client().call_raw(method, params);
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    const notRunning = /ENOENT|ECONNREFUSED|socket|not running/i.test(msg);
    console.error(
      notRunning
        ? `the local daemon is not answering on its socket: ${msg}`
        : msg,
    );
    process.exit(1);
  }
}

export async function runPeer(args: string[]): Promise<void> {
  const [sub, ...rest] = args;

  switch (sub) {
    case "invite": {
      // The address is required and deliberately has no default. Guessing one
      // means opening a port somewhere nobody chose.
      const host = rest.find((a) => !a.startsWith("--"));
      const portArg = rest[rest.indexOf("--port") + 1];
      const nameArg = rest[rest.indexOf("--as") + 1];
      if (!host) {
        console.log("usage: aibroker peer invite <address-others-reach-me-on> [--port N] [--as name]");
        console.log();
        console.log("The address is the one the OTHER machine will dial. On a Tailscale network");
        console.log("that is this machine's Tailscale address; for a local VM it is the address");
        console.log("the guest sees the host as. There is no default on purpose.");
        process.exit(1);
      }
      const r = await call("peer", {
        action: "invite",
        host,
        port: rest.includes("--port") ? Number(portArg) : undefined,
        name: rest.includes("--as") ? nameArg : undefined,
      });
      console.log(r.message ?? JSON.stringify(r));
      break;
    }

    case "join": {
      const invite = rest.join(" ").trim();
      if (!invite) {
        console.log("usage: aibroker peer join <the line the other machine printed>");
        process.exit(1);
      }
      const r = await call("peer", { action: "join", invite });
      console.log(r.message ?? JSON.stringify(r));
      break;
    }

    case "forget": {
      const name = rest[0];
      if (!name) { console.log("usage: aibroker peer forget <name>"); process.exit(1); }
      const r = await call("peer", { action: "forget", name });
      console.log(r.message ?? JSON.stringify(r));
      break;
    }

    case "list":
    case undefined: {
      const r = await call("peer", { action: "list" });
      console.log(r.listening ? `this hub accepts peers on ${r.listening}` : "this hub accepts no peers (no listener configured)");
      if (!r.peers?.length) {
        console.log("no machines paired. `aibroker peer invite <address>` on one, then `join` on the other.");
        break;
      }
      console.log();
      for (const p of r.peers) {
        console.log(`  ${p.reachable ? "●" : "○"} ${p.name.padEnd(14)} ${p.address}${p.reachable ? "" : `  — ${p.detail}`}`);
      }
      break;
    }

    /**
     * fleet — every machine, what it can do, and where its work stands.
     *
     * The question a lead actually asks is not "is the network up" but "who is
     * free, who can compile this, and is anybody's branch ready to look at".
     * One command, because a status that takes three commands to assemble is a
     * status nobody assembles.
     */
    case "fleet": {
      const { loadPeering, peerCall } = await import("../ipc/peering.js");
      const { machineFacts, branchState } = await import("./machine.js");
      const repo = rest.find((a) => !a.startsWith("--"));

      const here = machineFacts();
      const show = (label: string, m: any, checkout?: any) => {
        const caps = [
          m.canDriveScreen ? "screen" : "headless",
          `${m.cpus}cpu`,
          `${m.memoryGb}GB`,
          ...(m.has ?? []),
        ].join(" · ");
        console.log(`  ${label.padEnd(16)} ${caps}`);
        if (checkout?.branch) {
          const bits = [
            `on ${checkout.branch}`,
            checkout.head ? `at ${checkout.head}` : null,
            checkout.dirty ? `${checkout.dirty} uncommitted` : "clean",
            checkout.ahead ? `${checkout.ahead} ahead` : null,
            checkout.behind ? `${checkout.behind} behind` : null,
          ].filter(Boolean);
          console.log(`  ${" ".repeat(16)} ${bits.join(" · ")}`);
        } else if (checkout?.error) {
          console.log(`  ${" ".repeat(16)} ${checkout.error}`);
        }
      };

      console.log("this machine");
      show(here.name, here, repo ? branchState(repo) : undefined);

      const { peers } = loadPeering();
      if (!peers.length) return;
      console.log("\npaired machines");
      for (const p of peers) {
        const r = await peerCall(p, "where", repo ? { repo } : {});
        if (!r.ok) {
          console.log(`  ${p.name.padEnd(16)} unreachable — ${r.error}`);
          continue;
        }
        show(p.name, r.result.machine, r.result.checkout);
      }
      break;
    }

    case "standup": {
      const { collectStandup, renderStandup } = await import("./standup.js");
      const repo = rest.find((a) => !a.startsWith("--"));
      console.log(renderStandup(await collectStandup(repo)));
      break;
    }

    default:
      console.log("aibroker peer <invite|join|list|forget|fleet|standup>");
      console.log();
      console.log("  invite <address>   on the machine to be reached; prints one line to copy");
      console.log("  join <line>        on the other machine; pastes it and proves it works");
      console.log("  list               who is paired, and reachable right now");
      console.log("  forget <name>      unpair one");
      console.log("  fleet [repo]       every machine: what it can do, and where its branch is");
      console.log("  standup [repo]     what moved, what is moving, what is blocked");
  }
}
