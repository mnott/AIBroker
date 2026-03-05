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
    console.log("  help               Show this help");
    console.log("\nFlags:");
    console.log("  --version, -v      Show version");
    break;

  default:
    console.error(`Unknown command: ${command}`);
    console.error("Usage: aibroker [start|status|stop|ping|create-adapter|help]");
    process.exit(1);
}
