/**
 * daemon/index.ts — AIBroker standalone daemon entry point.
 *
 * Starts the hub: IPC server, PAILot WebSocket gateway, HybridSessionManager,
 * APIBackend, TTS, persistence. Adapters connect via the hub IPC socket.
 */

import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { unlinkSync, readFileSync, existsSync } from "node:fs";
import { setLogPrefix, log } from "../core/log.js";
import { setAppDir } from "../core/persistence.js";
import { IpcServer } from "../ipc/server.js";
import { AdapterRegistry } from "./adapter-registry.js";
import { registerCoreHandlers } from "./core-handlers.js";
import { startWsGateway, stopWsGateway } from "../adapters/pailot/gateway.js";
import { APIBackend } from "../backend/api.js";
import { HybridSessionManager, setHybridManager } from "../core/hybrid.js";
import { router } from "../core/router.js";
import { loadSessionRegistry, loadVoiceConfig } from "../core/persistence.js";
import { setCommandHandler } from "../core/state.js";
import { createHubCommandHandler } from "./commands.js";
import type { CommandContext } from "./command-context.js";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf-8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export const DAEMON_SOCKET_PATH = "/tmp/aibroker.sock";

export async function startDaemon(options?: {
  appDir?: string;
  socketPath?: string;
}): Promise<void> {
  setLogPrefix("aibroker");
  const appDir = options?.appDir ?? join(homedir(), ".aibroker");
  const socketPath = options?.socketPath ?? DAEMON_SOCKET_PATH;
  setAppDir(appDir);

  // Load environment from ~/.aibroker/env (KEY=VALUE, one per line)
  // This allows launchd-managed daemons to pick up API tokens without
  // needing them in the plist or shell profile.
  const envFile = join(appDir, "env");
  if (existsSync(envFile)) {
    try {
      const lines = readFileSync(envFile, "utf-8").split("\n");
      let loaded = 0;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();
        // Strip surrounding quotes
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        if (!process.env[key]) {
          process.env[key] = value;
          loaded++;
        }
      }
      if (loaded > 0) log(`Loaded ${loaded} env var(s) from ${envFile}`);
    } catch (err) {
      log(`Warning: could not read ${envFile}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Initialize session management
  const apiBackend = new APIBackend({
    type: "api",
    provider: "anthropic",
    model: process.env.AIBROKER_MODEL ?? "sonnet",
    cwd: process.env.AIBROKER_CWD,
    maxTurns: Number(process.env.AIBROKER_MAX_TURNS) || 30,
    maxBudgetUsd: Number(process.env.AIBROKER_MAX_BUDGET) || 1.0,
    permissionMode: process.env.AIBROKER_PERMISSION_MODE ?? "acceptEdits",
    skipDefaultSession: true,
  });
  const manager = new HybridSessionManager(apiBackend);
  setHybridManager(manager);
  router.setDefaultBackend(apiBackend);

  // Restore persisted state
  loadSessionRegistry();
  loadVoiceConfig();

  // Adapter registry
  const adapterRegistry = new AdapterRegistry();

  // Create the hub command handler
  const hubCommandHandler = createHubCommandHandler();
  // Wrap it as a CommandHandler for backward compat (embedded mode fallback)
  setCommandHandler((text, timestamp) => {
    const fallbackCtx: CommandContext = {
      reply: async (msg) => { log(`[hub fallback reply] ${msg.slice(0, 80)}`); },
      replyImage: async () => { log("[hub fallback] image reply not supported in embedded mode"); },
      replyVoice: async () => { log("[hub fallback] voice reply not supported in embedded mode"); },
      source: "hub",
    };
    return hubCommandHandler(text, timestamp, fallbackCtx);
  });
  // Wire the full handler with adapter-aware context into the registry
  adapterRegistry.setCommandHandler(hubCommandHandler);

  // IPC server on the hub socket
  const ipcServer = new IpcServer(socketPath);
  registerCoreHandlers(ipcServer, adapterRegistry, apiBackend, manager);
  ipcServer.start();
  adapterRegistry.startHealthPolling();

  // PAILot WebSocket gateway
  startWsGateway((text: string, timestamp: number) => {
    adapterRegistry.dispatchIncoming("pailot", text, timestamp);
  });

  console.log(`AIBroker daemon v${getVersion()} started`);
  console.log(`  Socket:  ${socketPath}`);
  console.log(`  AppDir:  ${appDir}`);

  // Graceful shutdown — ensure socket cleanup even on abrupt exit
  const shutdown = (signal: string) => {
    console.log(`\n[aibroker] ${signal} received. Stopping.`);
    adapterRegistry.stopHealthPolling();
    stopWsGateway();
    ipcServer.stop();
    // Belt-and-suspenders: remove socket in case ipcServer.stop() didn't
    try { unlinkSync(socketPath); } catch { /* already gone */ }
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  // Clean up on uncaught exceptions too
  process.on("uncaughtException", (err) => {
    console.error(`[aibroker] Uncaught exception:`, err);
    try { unlinkSync(socketPath); } catch { /* ignore */ }
    process.exit(1);
  });

  await new Promise(() => {});
}
