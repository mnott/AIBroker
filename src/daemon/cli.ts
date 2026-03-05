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
import { createAdapter } from "./create-adapter.js";

const args = process.argv.slice(2);
const [command, ...rest] = args;

switch (command) {
  case "start":
  case undefined:
    await startDaemon();
    break;

  case "status": {
    const client = new WatcherClient(DAEMON_SOCKET_PATH);
    try {
      const result = await client.call_raw("status", {});
      console.log(JSON.stringify(result, null, 2));
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

  default:
    console.error(`Unknown command: ${command}`);
    console.error("Usage: aibroker [start|status|stop|create-adapter]");
    process.exit(1);
}
