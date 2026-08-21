#!/usr/bin/env node
/**
 * daemon/cli.ts — CLI for the aibroker daemon.
 *
 * Usage:
 *   aibroker start              Start the daemon
 *   aibroker start --socket /tmp/aibroker.sock
 *   aibroker status             Query daemon status
 *   aibroker stop               Send SIGTERM to daemon
 *   aibroker create-adapter <name> [--display-name <Name>] [--output <dir>]
 *                               Scaffold a new adapter from the built-in template
 *   aibroker ota <subcommand>   OTA install hub (Docker + Tailscale Serve)
 *     up                        Start container, write .env, configure Tailscale Serve
 *     down                      Stop container
 *     status                    Show container + tailscale serve status
 *     logs [-f]                 Show container logs
 *     setup-serve               Configure Tailscale Serve only
 */

import { startDaemon, DAEMON_SOCKET_PATH } from "./index.js";
import { WatcherClient } from "../ipc/client.js";
import { validateHubStatus } from "../ipc/validate.js";
import { createAdapter } from "./create-adapter.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

function getVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

const args = process.argv.slice(2);
const [command, ...rest] = args;

if (args.includes("--version") || args.includes("-v")) {
  console.log(`aibroker ${getVersion()}`);
  process.exit(0);
}

switch (command) {
  case "start":
  case undefined:
    await startDaemon();
    break;

  case "status": {
    const client = new WatcherClient(DAEMON_SOCKET_PATH);
    try {
      const raw = await client.call_raw("status", {});
      const status = validateHubStatus(raw);

      console.log(`AIBroker Hub v${status.version}`);
      console.log(`  Active session: ${status.activeSession ?? "(none)"}`);
      console.log(`  Sessions:       ${status.activeSessions}`);
      console.log(`  Adapters:       ${status.adapters.join(", ") || "(none)"}`);

      if (Object.keys(status.adapterHealth).length > 0) {
        console.log("\n  Adapter Health:");
        for (const [name, h] of Object.entries(status.adapterHealth)) {
          const icon = h.status === "ok" ? "●" : h.status === "degraded" ? "◐" : "○";
          const detail = h.detail ? ` — ${h.detail}` : "";
          const msgs = `↓${h.stats.messagesReceived} ↑${h.stats.messagesSent}`;
          console.log(`    ${icon} ${name}: ${h.status} (${h.connectionStatus}) ${msgs}${detail}`);
        }
      }
    } catch (err) {
      console.error("Daemon not running:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    break;
  }

  case "stop": {
    const client = new WatcherClient(DAEMON_SOCKET_PATH);
    try {
      // Send a ping to confirm it's running, then signal stop
      await client.call_raw("ping", {});
      // The daemon listens for SIGTERM — find its PID via the socket
      const { execSync } = await import("node:child_process");
      // lsof to find the daemon process listening on the socket
      try {
        const output = execSync(`lsof -U 2>/dev/null | grep ${DAEMON_SOCKET_PATH}`, { encoding: "utf-8" });
        const pid = output.split(/\s+/)[1];
        if (pid) {
          process.kill(parseInt(pid, 10), "SIGTERM");
          console.log(`Sent SIGTERM to daemon (PID ${pid})`);
        } else {
          console.error("Could not determine daemon PID");
          process.exit(1);
        }
      } catch {
        console.error("Could not find daemon process. Is it running?");
        process.exit(1);
      }
    } catch (err) {
      console.error("Daemon not running:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    break;
  }

  case "ping": {
    const client = new WatcherClient(DAEMON_SOCKET_PATH);
    try {
      const result = await client.call_raw("ping", {});
      const uptime = typeof result.uptime === "number" ? result.uptime : 0;
      const hours = Math.floor(uptime / 3600);
      const mins = Math.floor((uptime % 3600) / 60);
      console.log(`pong — uptime: ${hours}h ${mins}m`);
    } catch (err) {
      console.error("Daemon not running:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    break;
  }

  case "ota": {
    const { runOta } = await import("./ota.js");
    await runOta(rest);
    break;
  }

  case "sessions": {
    const { runSessions } = await import("./sessions.js");
    await runSessions(rest);
    break;
  }

  case "dispatch": {
    const { runDispatch } = await import("./dispatch-cli.js");
    await runDispatch(rest);
    break;
  }

  case "ask": {
    const { runAsk } = await import("./ask-cli.js");
    await runAsk(rest);
    break;
  }

  case "audit": {
    const { runAudit } = await import("./audit-cli.js");
    await runAudit(rest);
    break;
  }

  case "todoist": {
    const { runTodoist } = await import("./todoist-cli.js");
    await runTodoist(rest);
    break;
  }

  case "inbound": {
    const { runInbound } = await import("./inbound-cli.js");
    await runInbound(rest);
    break;
  }

  case "budget": {
    const { runBudget } = await import("./budget-cli.js");
    await runBudget(rest);
    break;
  }

  case "launch": {
    const { runLaunch } = await import("./launch-cli.js");
    await runLaunch(rest);
    break;
  }

  case "outbound": {
    const { runOutbound } = await import("./outbound-cli.js");
    await runOutbound(rest);
    break;
  }

  case "create-adapter": {
    // Parse arguments: name, --display-name <Name>, --output <dir>
    const adapterName = rest.find((a) => !a.startsWith("--"));
    if (!adapterName) {
      console.error("Usage: aibroker create-adapter <adapter-name> [--display-name <Name>] [--output <dir>]");
      console.error("");
      console.error("Examples:");
      console.error("  aibroker create-adapter my-signal");
      console.error("  aibroker create-adapter my-signal --display-name Signal");
      console.error("  aibroker create-adapter my-signal --display-name Signal --output ~/adapters/my-signal");
      process.exit(1);
    }

    const displayNameIdx = rest.indexOf("--display-name");
    const displayName = displayNameIdx !== -1 ? rest[displayNameIdx + 1] : undefined;

    const outputIdx = rest.indexOf("--output");
    const outputDir = outputIdx !== -1 ? rest[outputIdx + 1] : undefined;

    await createAdapter({ adapterName, displayName, outputDir });
    break;
  }

  /**
   * manage — talk to the manager for a session, from ANY shell.
   *
   * NOT from inside the managed session's input box. That box cannot carry a
   * control channel: while the session is busy the terminal queues what you
   * type, so nothing reaches a hook until the current turn ends — which is
   * exactly when you most want to ask. Both observations came from watching it
   * rather than reasoning about it. So the channel is a separate shell: another
   * pane, another window, a key binding, anything that is not the input line of
   * the session you are trying to interrupt.
   *
   *   aibroker manage <session>                 what is going on
   *   aibroker manage <session> <objective>     start, or send an instruction
   *   aibroker manage <session> off             stop
   */
  case "peer":
  case "fleet": {
    const { runPeer } = await import("./peer-cli.js");
    // `aibroker fleet` is the same thing people will actually type, so it is
    // the same command rather than a second one to keep in step.
    await runPeer(command === "fleet" ? ["fleet", ...rest] : rest);
    break;
  }

  case "manage": {
    // The session is optional when there is an obvious one: run from a pane,
    // the terminal's own id is in the environment and naming it again is
    // ceremony. Naming one is how you reach a DIFFERENT session — which is the
    // case that matters, since a busy session cannot answer for itself.
    const here = (process.env.ITERM_SESSION_ID ?? "").split(":").pop() ?? "";
    const first = args[1];
    const KEYWORDS = new Set(["", "status", "state", "what", "info", "show", "off", "stop", "pause", "resume", "now", "rules", "shift", "help", "?"]);
    // A leading dash is never a session name. Without this, `manage --help`
    // was read as "the session called --help" and answered "no live session
    // matches" — a true statement about a question nobody asked.
    const isKeyword = (s: string | undefined) =>
      s === undefined || s.startsWith("-") || KEYWORDS.has(s.toLowerCase());

    /**
     * BOTH ORDERS WORK, because both get typed.
     *
     * `manage <session> status` is the documented one and `manage status
     * <session>` is what a person writes when the verb is on their mind. The
     * second used to resolve to whatever pane the command ran in and turn the
     * rest into an objective — so `aibroker manage status <session>` created a
     * manager on a shell with the objective "status <session>". Accepting both
     * removes the trap rather than documenting around it.
     */
    let session: string;
    let rest: string[];
    /**
     * `rules` never takes a session, and the both-orders rule below would give
     * it one: in `manage rules from <path>` the word after the verb is not a
     * keyword, so it was read as the session name and the command failed with
     * "no live session matches from". The standing rules belong to every
     * managed session at once, so the only sensible session here is whichever
     * pane the command was typed in.
     */
    if ((first ?? "").toLowerCase() === "rules") {
      session = here || "-";
      rest = args.slice(1);
    } else if (!isKeyword(first)) {
      session = first!;
      rest = args.slice(2);
    } else if (isKeyword(first) && args[2] !== undefined && !isKeyword(args[2])) {
      session = args[2];
      rest = [first!, ...args.slice(3)];
    } else {
      session = here;
      rest = args.slice(1);
    }

    if (!session) {
      console.log("usage: aibroker manage [session] [objective | question | off | pause | resume | now | help]");
      console.log("       the session may be omitted when run inside one.");
      process.exit(1);
    }
    const client = new WatcherClient(DAEMON_SOCKET_PATH);
    try {
      const raw = (await client.call_raw("manage", {
        session,
        arg: rest.join(" "),
      })) as { message?: string };
      console.log(raw?.message ?? "(no answer)");
    } catch (e) {
      console.error(`manage failed: ${(e as Error).message}`);
      process.exitCode = 1;
    }
    break;
  }

  case "help":
  case "--help":
  case "-h":
    console.log(`aibroker ${getVersion()} — AI message broker daemon\n`);
    console.log("Commands:");
    console.log("  start              Start the daemon (default)");
    console.log("  status             Show daemon status and adapter health");
    console.log("  stop               Stop the running daemon");
    console.log("  ping               Quick heartbeat check");
    console.log("  create-adapter     Scaffold a new adapter project");
    console.log("  ota <sub>          OTA hub: up|down|status|logs|setup-serve");
    console.log("  sessions <sub>     Session backup: snapshot|restore|checkpoint|list|install");
    console.log("  dispatch <project> Deliver a work order to a project's session (--stdin --json)");
    console.log("  ask <project>      Ask a session a question and wait for its reply (--stdin --json)");
    console.log("  audit              What one session did to another (--session|--trace|--bodies)");
    console.log("  todoist <sub>      Todoist inbound channel: auth|status");
    console.log("  help               Show this help");
    console.log("\nFlags:");
    console.log("  --version, -v      Show version");
    break;

  default:
    console.error(`Unknown command: ${command}`);
    console.error("Usage: aibroker [start|status|stop|ping|create-adapter|ota|sessions|dispatch|ask|audit|help]");
    process.exit(1);
}
