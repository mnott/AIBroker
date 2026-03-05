/**
 * daemon/core-handlers.ts — Hub-level IPC handlers.
 *
 * Registers the core methods that any adapter or MCP client can call
 * on the hub socket. Transport-specific methods (send, contacts, history)
 * are NOT registered here — adapters handle those on their own sockets.
 *
 * Phase 1 methods:
 *   register_adapter  — adapter announces itself to the hub
 *   unregister_adapter
 *   adapter_list      — list connected adapters
 *   sessions          — list hybrid sessions
 *   switch            — switch active session
 *   end_session       — end a hybrid session
 *   broadcast_status  — push status to all PAILot clients
 *   voice_config      — get/set TTS config
 *   status            — hub health/connection summary
 */

import type { IpcServer } from "../ipc/server.js";
import type { AdapterRegistry } from "./adapter-registry.js";
import type { APIBackend } from "../backend/api.js";
import type { HybridSessionManager } from "../core/hybrid.js";
import { broadcastStatus } from "../adapters/pailot/gateway.js";
import { saveVoiceConfig } from "../core/persistence.js";
import { voiceConfig, setVoiceConfig } from "../core/state.js";

export function registerCoreHandlers(
  server: IpcServer,
  registry: AdapterRegistry,
  _apiBackend: APIBackend,
  manager: HybridSessionManager,
): void {

  server.on("register_adapter", async (req) => {
    const { name, socketPath } = req.params as { name: string; socketPath: string };
    if (!name || !socketPath) return { ok: false, error: "name and socketPath required" };
    registry.register({ name, socketPath, registeredAt: Date.now() });
    return { ok: true, result: { registered: true } };
  });

  server.on("unregister_adapter", async (req) => {
    const { name } = req.params as { name: string };
    registry.unregister(name);
    return { ok: true, result: { unregistered: true } };
  });

  server.on("adapter_list", async (_req) => {
    return { ok: true, result: { adapters: registry.list() } };
  });

  server.on("sessions", async (_req) => {
    const sessions = manager.listSessions().map((s, i) => ({
      index: i + 1,
      name: s.name,
      kind: s.kind,
      active: manager.activeSession?.id === s.id,
    }));
    return { ok: true, result: { sessions } };
  });

  server.on("switch", async (req) => {
    const { target } = req.params as { target: string | number };
    const index = typeof target === "number" ? target : parseInt(String(target), 10);
    const session = manager.switchToIndex(index);
    if (!session) return { ok: false, error: `Session ${target} not found` };
    return { ok: true, result: { switched: true, name: session.name } };
  });

  server.on("end_session", async (req) => {
    const { target } = req.params as { target: string | number };
    const index = typeof target === "number" ? target : parseInt(String(target), 10);
    const session = manager.removeByIndex(index);
    if (!session) return { ok: false, error: `Session ${target} not found` };
    return { ok: true, result: { ended: true, name: session.name } };
  });

  server.on("broadcast_status", async (req) => {
    const { status } = req.params as { status: string };
    broadcastStatus(status);
    return { ok: true, result: { status } };
  });

  server.on("voice_config", async (req) => {
    const { action, ...updates } = req.params as { action: "get" | "set" } & Record<string, unknown>;
    if (action === "get") {
      return { ok: true, result: { config: voiceConfig } };
    }
    const merged = { ...voiceConfig, ...updates };
    setVoiceConfig(merged as typeof voiceConfig);
    saveVoiceConfig(merged as typeof voiceConfig);
    return { ok: true, result: { success: true, config: merged } };
  });

  server.on("status", async (_req) => {
    return {
      ok: true,
      result: {
        version: "1.0.0",
        adapters: registry.list().map(a => a.name),
        activeSessions: manager.listSessions().length,
        activeSession: manager.activeSession?.name ?? null,
      },
    };
  });
}
