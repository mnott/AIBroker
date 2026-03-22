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
import { startWsGateway, stopWsGateway, setScreenshotHandler, broadcastText, broadcastVoice, broadcastImage, handleMqttCommand, transcribeAndRoute } from "../adapters/pailot/gateway.js";
import { startMqttBroker, stopMqttBroker, setMqttInboundHandler } from "../adapters/pailot/mqtt-broker.js";
import { handleScreenshot } from "./screenshot.js";
import { APIBackend } from "../backend/api.js";
import { HybridSessionManager, setHybridManager } from "../core/hybrid.js";
import { router } from "../core/router.js";
import { loadSessionRegistry, loadVoiceConfig } from "../core/persistence.js";
import { setCommandHandler, setAibpBridge } from "../core/state.js";
import { createHubCommandHandler } from "./commands.js";
import type { CommandContext } from "./command-context.js";
import { WatcherClient } from "../ipc/client.js";
import { fileURLToPath } from "node:url";
import { AibpBridge } from "../aibp/bridge.js";
import { typeIntoSession, findClaudeSession, isClaudeRunningInSession } from "../adapters/iterm/core.js";
import { activeItermSessionId, setActiveItermSessionId, setLastRoutedSessionId } from "../core/state.js";
import { pruneStaleContexts } from "./image-context.js";

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

const KNOWN_ADAPTERS: { name: string; socketPath: string }[] = [
  { name: "whazaa", socketPath: "/tmp/whazaa-watcher.sock" },
  { name: "telex", socketPath: "/tmp/telex-watcher.sock" },
];

async function discoverRunningAdapters(registry: AdapterRegistry): Promise<void> {
  for (const { name, socketPath } of KNOWN_ADAPTERS) {
    if (registry.get(name)) continue; // already registered
    if (!existsSync(socketPath)) continue;
    try {
      const client = new WatcherClient(socketPath);
      await Promise.race([
        client.call_raw("health", {}),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 3000)),
      ]);
      registry.register({ name, socketPath, registeredAt: Date.now() });
      log(`[hub] auto-discovered adapter: ${name}`);
    } catch {
      // Socket exists but adapter not responding — skip
    }
  }
}

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

  // AIBP bridge — IRC-inspired message routing layer
  const aibpBridge = new AibpBridge();
  setAibpBridge(aibpBridge);
  // Register PAILot as a mobile plugin. The callback receives AIBP messages
  // to deliver to connected WebSocket clients (wired after gateway starts).
  // This is registered early so it's available before the first connection.
  aibpBridge.registerMobile("pailot", (aibpMsg) => {
    // Forward AIBP messages to PAILot gateway broadcast functions
    const sessionId = aibpMsg.src.startsWith("session:")
      ? aibpMsg.src.slice(8)
      : undefined;
    log(`[AIBP→PAILot] type=${aibpMsg.type} src=${aibpMsg.src} → sessionId=${sessionId?.slice(0, 8) ?? "none"}`);
    switch (aibpMsg.type) {
      case "TEXT": {
        const p = aibpMsg.payload as { content: string };
        // direct=true: explicit pailot_send replies bypass session gate
        broadcastText(p.content, sessionId, true);
        break;
      }
      case "VOICE": {
        const p = aibpMsg.payload as { audioBase64: string; transcript?: string };
        void broadcastVoice(Buffer.from(p.audioBase64, "base64"), p.transcript ?? "", sessionId, true);
        break;
      }
      case "IMAGE": {
        const p = aibpMsg.payload as { imageBase64: string; caption?: string };
        broadcastImage(Buffer.from(p.imageBase64, "base64"), p.caption, sessionId, true);
        break;
      }
      case "TYPING": {
        // Typing broadcast handled directly by gateway — no AIBP routing needed yet
        break;
      }
    }
  });

  // Create the hub command handler
  const hubCommandHandler = createHubCommandHandler();

  // Register the hub as an AIBP session handler — receives inbound messages
  // routed to session channels (e.g., from PAILot via routeFromMobile).
  aibpBridge.registerSessionHandler((aibpMsg) => {
    // Extract session ID from destination (session:XYZ) or source
    const sessionId = aibpMsg.dst.startsWith("session:")
      ? aibpMsg.dst.slice(8)
      : aibpMsg.src.startsWith("session:")
        ? aibpMsg.src.slice(8)
        : undefined;

    // Build CommandContext with AIBP-routed reply callbacks
    const ctx: CommandContext = {
      reply: async (text: string) => {
        aibpBridge.routeToMobile(sessionId ?? "", text);
      },
      replyImage: async (buf: Buffer, caption: string) => {
        aibpBridge.routeToMobile(sessionId ?? "", caption ?? "", "IMAGE", {
          imageBase64: buf.toString("base64"),
          mimeType: "image/png",
        });
      },
      replyVoice: async (audioBuf: Buffer, caption: string) => {
        aibpBridge.routeToMobile(sessionId ?? "", caption, "VOICE", {
          audioBase64: audioBuf.toString("base64"),
        });
      },
      typing: (active: boolean) => {
        aibpBridge.sendTyping(sessionId ?? "", active);
      },
      source: "pailot",
      sessionId,
    };

    // Dispatch based on message type
    let text = "";
    switch (aibpMsg.type) {
      case "TEXT":
        text = (aibpMsg.payload as { content: string }).content;
        break;
      case "VOICE":
        text = (aibpMsg.payload as { transcript?: string }).transcript ?? "";
        break;
      case "IMAGE":
        text = (aibpMsg.payload as { caption?: string }).caption ?? "";
        break;
      default:
        log(`[AIBP→Hub] Ignoring ${aibpMsg.type} message`);
        return;
    }

    if (text.trim()) {
      void hubCommandHandler(text, aibpMsg.ts, ctx);
    }
  });
  // Register iTerm2 as a terminal plugin — makes it addressable via AIBP.
  // Messages sent to terminal:iterm are typed into the active iTerm session.
  // Keyboard control commands are registered as terminal-owned AIBP commands.
  const terminalCommands = [
    { name: "cc", description: "Send Ctrl+C to active session", args: "" },
    { name: "esc", description: "Send Escape to active session", args: "" },
    { name: "enter", description: "Send Enter to active session", args: "" },
    { name: "tab", description: "Send Tab to active session", args: "" },
    { name: "up", description: "Send Up arrow to active session", args: "" },
    { name: "down", description: "Send Down arrow to active session", args: "" },
    { name: "left", description: "Send Left arrow to active session", args: "" },
    { name: "right", description: "Send Right arrow to active session", args: "" },
    { name: "pick", description: "Select menu option N", args: "<N> [text]" },
  ];
  aibpBridge.registerTerminal("iterm", (aibpMsg) => {
    if (aibpMsg.type === "TEXT") {
      const content = (aibpMsg.payload as { content: string }).content;
      // Determine target session from AIBP message source address
      const targetSession = aibpMsg.src.startsWith("session:")
        ? aibpMsg.src.slice(8)
        : activeItermSessionId;

      if (targetSession) {
        typeIntoSession(targetSession, content);
      } else {
        // Fallback: find any Claude session
        const found = findClaudeSession();
        if (found && isClaudeRunningInSession(found)) {
          setActiveItermSessionId(found);
          typeIntoSession(found, content);
        } else {
          log(`[AIBP→Terminal] No iTerm session available for delivery`);
        }
      }
    } else if (aibpMsg.type === "COMMAND") {
      const payload = aibpMsg.payload as { command: string; args: Record<string, unknown> };
      if (payload.command === "type" && payload.args.text) {
        const sessionId = (payload.args.sessionId as string) || activeItermSessionId;
        if (sessionId) {
          typeIntoSession(sessionId, payload.args.text as string);
        }
      }
    }
  }, terminalCommands);

  // Wrap it as a CommandHandler for backward compat (embedded mode fallback)
  setCommandHandler((text, timestamp) => {
    const fallbackCtx: CommandContext = {
      reply: async (msg) => { log(`[hub fallback reply] ${msg.slice(0, 80)}`); },
      replyImage: async () => { log("[hub fallback] image reply not supported in embedded mode"); },
      replyVoice: async () => { log("[hub fallback] voice reply not supported in embedded mode"); },
      typing: () => {},
      source: "hub",
      // sessionId intentionally omitted — fallback/embedded mode has no session
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

  // Prune stale image contexts every 5 minutes (30-minute TTL enforced inside)
  setInterval(() => {
    const evicted = pruneStaleContexts();
    if (evicted > 0) log(`[hub] pruned ${evicted} stale image context(s)`);
  }, 5 * 60 * 1000).unref();

  // Auto-discover adapters that were already running before the hub (re)started.
  // Probe well-known socket paths and register any that respond to "ping".
  // Also register them as AIBP transport plugins.
  void discoverRunningAdapters(adapterRegistry).then(() => {
    for (const adapter of adapterRegistry.list()) {
      aibpBridge.registerTransport(adapter.name, () => {
        // Legacy adapters use IPC, not direct AIBP send
      });
    }
  });

  // PAILot WebSocket gateway — disabled, replaced by MQTT
  // startWsGateway((text: string, timestamp: number) => {
  //   adapterRegistry.dispatchIncoming("pailot", text, timestamp);
  // });

  // PAILot MQTT broker — takes over port 8765
  setMqttInboundHandler((sessionId, type, payload) => {
    const bridge = aibpBridge;
    if (type === "command") {
      const command = (payload.command as string) ?? "";
      // Args may be nested under 'args' key or spread at top level
      const nested = payload.args as Record<string, unknown> | undefined;
      const args = nested ?? payload;
      log(`[MQTT→Hub] command: ${command} args=${JSON.stringify(args).slice(0, 100)}`);
      handleMqttCommand(command, args);
      return;
    }

    // Text/voice/image from app — route through AIBP bridge (same as WS path)
    const routeSession = sessionId || undefined;
    if (!routeSession) {
      log(`[MQTT→Hub] no sessionId in inbound ${type} message — dropping`);
      return;
    }

    if (type === "text") {
      const content = (payload.content as string) ?? "";
      if (!content.trim()) return;
      log(`[MQTT→Hub] text from session ${routeSession.slice(0, 8)}...`);
      bridge.routeFromMobile(routeSession, content);
    } else if (type === "voice" && payload.audioBase64) {
      log(`[MQTT→Hub] voice from session ${routeSession.slice(0, 8)}...`);
      const msgId = typeof payload.messageId === "string" ? payload.messageId : undefined;
      // Set routing session before transcription
      setLastRoutedSessionId(routeSession!);
      setActiveItermSessionId(routeSession!);
      transcribeAndRoute(
        payload.audioBase64 as string,
        (_text: string, _ts: number) => { /* onMessage not needed for MQTT path */ },
        msgId,
      ).catch((err) => log(`[MQTT→Hub] voice transcription error: ${err}`));
    } else if (type === "image") {
      const caption = (payload.caption as string) ?? "";
      log(`[MQTT→Hub] image from session ${routeSession.slice(0, 8)}...`);
      bridge.routeFromMobile(routeSession, caption || "(image)", "IMAGE", {
        imageBase64: payload.imageBase64 as string,
        mimeType: (payload.mimeType as string) ?? "image/jpeg",
      });
    }
  });
  startMqttBroker(getVersion());

  // Wire screenshot handler so PAILot /ss commands work
  setScreenshotHandler(async (source, targetSessionId) => {
    const sessionId = targetSessionId ?? manager.activeSession?.backendSessionId;
    const ctx: CommandContext = {
      reply: async (text) => { broadcastText(text, sessionId); },
      replyImage: async (buf, caption) => { broadcastImage(buf, caption, sessionId); },
      replyVoice: async () => {},
      typing: () => {},
      source: source ?? "pailot",
      sessionId,
    };
    await handleScreenshot(ctx);
  });

  console.log(`AIBroker daemon v${getVersion()} started (AIBP ${aibpBridge.registry.listPlugins().length > 0 ? "active" : "standby"})`);
  console.log(`  Socket:  ${socketPath}`);
  console.log(`  AppDir:  ${appDir}`);
  console.log(`  AIBP:    ${aibpBridge.listPlugins().join(", ") || "(no plugins yet)"}`);

  // Graceful shutdown — ensure socket cleanup even on abrupt exit
  const shutdown = (signal: string) => {
    console.log(`\n[aibroker] ${signal} received. Stopping.`);
    adapterRegistry.stopHealthPolling();
    stopMqttBroker();
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
