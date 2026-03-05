/**
 * daemon/cli.ts — CLI for the aibroker daemon.
 *
 * Usage:
 *   aibroker start              Start the daemon
 *   aibroker start --socket /tmp/aibroker.sock
 *   aibroker status             Query daemon status
 *   aibroker stop               Send SIGTERM to daemon
 */

import { startDaemon, DAEMON_SOCKET_PATH } from "./index.js";
import { WatcherClient } from "../ipc/client.js";

const [, , command] = process.argv;

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

  default:
    console.error(`Unknown command: ${command}`);
    console.error("Usage: aibroker [start|status|stop]");
    process.exit(1);
}
