/**
 * daemon/index.ts — AIBroker standalone daemon entry point.
 *
 * Starts the hub: IPC server, PAILot WebSocket gateway, HybridSessionManager,
 * APIBackend, TTS, persistence. Adapters connect via the hub IPC socket.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { unlinkSync } from "node:fs";
import { setLogPrefix } from "../core/log.js";
import { setAppDir } from "../core/persistence.js";
import { IpcServer } from "../ipc/server.js";
import { AdapterRegistry } from "./adapter-registry.js";
import { registerCoreHandlers } from "./core-handlers.js";
import { startWsGateway, stopWsGateway } from "../adapters/pailot/gateway.js";
import { APIBackend } from "../backend/api.js";
import { HybridSessionManager, setHybridManager } from "../core/hybrid.js";
import { router } from "../core/router.js";
import { loadSessionRegistry, loadVoiceConfig } from "../core/persistence.js";

export const DAEMON_SOCKET_PATH = "/tmp/aibroker.sock";

export async function startDaemon(options?: {
  appDir?: string;
  socketPath?: string;
}): Promise<void> {
  setLogPrefix("aibroker");
  const appDir = options?.appDir ?? join(homedir(), ".aibroker");
  const socketPath = options?.socketPath ?? DAEMON_SOCKET_PATH;
  setAppDir(appDir);

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

  // Adapter registry (Phase 2 will expand this)
  const adapterRegistry = new AdapterRegistry();

  // IPC server on the hub socket
  const ipcServer = new IpcServer(socketPath);
  registerCoreHandlers(ipcServer, adapterRegistry, apiBackend, manager);
  ipcServer.start();
  adapterRegistry.startHealthPolling();

  // PAILot WebSocket gateway
  startWsGateway((text: string, timestamp: number) => {
    adapterRegistry.dispatchIncoming("pailot", text, timestamp);
  });

  console.log(`AIBroker daemon started`);
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
