/**
 * daemon/index.ts — AIBroker standalone daemon entry point.
 *
 * Starts the hub: IPC server, PAILot WebSocket gateway, HybridSessionManager,
 * APIBackend, TTS, persistence. Adapters connect via the hub IPC socket.
 */

import { join, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import { unlinkSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { setLogPrefix, log } from "../core/log.js";
import { loadEnvFile } from "../core/env.js";
import { setAppDir } from "../core/persistence.js";
import { IpcServer } from "../ipc/server.js";
import { AdapterRegistry } from "./adapter-registry.js";
import { registerCoreHandlers } from "./core-handlers.js";
import { startTodoistWebhook } from "./todoist-webhook.js";
import { startMailboxWatch } from "./mailbox-watch.js";
import { startWsGateway, stopWsGateway, setScreenshotHandler, broadcastText, broadcastVoice, broadcastImage, handleMqttCommand, transcribeAndRoute, setVoiceBatchSession } from "../adapters/pailot/gateway.js";
import { startMqttBroker, stopMqttBroker, setMqttInboundHandler, mqttPublishTyping, getMqttClientCount, mqttPublishText, mqttPublishControl } from "../adapters/pailot/mqtt-broker.js";
import { registerToken as apnsRegisterToken, sendPush as apnsSendPush } from "../apns/client.js";
import { loadQueue, flushQueue } from "../adapters/pailot/message-queue.js";
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
import { findClaudeSession } from "../adapters/iterm/core.js";
import { typeIntoSession, isClaudeRunningInSession, snapshotAllSessions } from "../transport/sync-facade.js";
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
  const loaded = loadEnvFile(appDir);
  if (loaded > 0) log(`Loaded ${loaded} env var(s) from ${join(appDir, "env")}`);

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
        const p = aibpMsg.payload as { audioBase64: string; transcript?: string; groupId?: string; chunkIndex?: number; totalChunks?: number };
        const chunkMeta = p.groupId ? { groupId: p.groupId, chunkIndex: p.chunkIndex!, totalChunks: p.totalChunks! } : undefined;
        void broadcastVoice(Buffer.from(p.audioBase64, "base64"), p.transcript ?? "", sessionId, true, chunkMeta);
        break;
      }
      case "IMAGE": {
        const p = aibpMsg.payload as { imageBase64: string; caption?: string; mimeType?: string };
        broadcastImage(Buffer.from(p.imageBase64, "base64"), p.caption, sessionId, true, p.mimeType);
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

  // Todoist inbound channel. Enabled only when TODOIST_CLIENT_SECRET is set;
  // a task filed from a phone or fired by a reminder reaches the owning
  // session through the same dispatch path as everything else, so it inherits
  // the shell guard, the delivery confirmation and the audit trail.
  // "Queued" is true when it is said and false if nobody ever reads it. This
  // is the thing that notices the difference.
  startMailboxWatch();

  // Keep the Todoist token valid here, in the daemon, because the daemon is the
  // one process that is always up. Every other holder of this responsibility is
  // occasional: a CLI invocation, an MCP shim loaded once per session, a reply
  // path that only refreshes after a 401 has already failed. Todoist issues
  // one-hour tokens, so "refresh when someone needs it" means the token is
  // expired for most of the day — measured 8.4 hours expired on 2026-08-04.
  if (process.env.TODOIST_CLIENT_ID && process.env.TODOIST_CLIENT_SECRET) {
    const { startTokenKeeper } = await import("./todoist-oauth.js");
    startTokenKeeper();
  } else {
    log("todoist-oauth: keeper not started — TODOIST_CLIENT_ID/SECRET not set");
  }

  startTodoistWebhook({
    deliver: async (project, body, opts) => {
      const { dispatch } = await import("./dispatch.js");
      const r = await dispatch(project, body, { prefix: opts?.prefix });
      return { outcome: r.outcome, session: r.session, reason: r.reason || undefined };
    },
    // Curated PAI aliases FIRST — those are the names dispatch can actually
    // resolve. Live session names are added too, but a name that only exists
    // as a running tab will be addressed and then fail to launch, which is
    // worse than not recognising it: it looks delivered and is not.
    knownOwners: async () => {
      const names: string[] = [];
      try {
        const { listPaiProjects } = await import("./pai-projects.js");
        for (const p of await listPaiProjects()) names.push(...(p.names ?? [p.name]));
      } catch (e) {
        log(`todoist: could not list PAI projects for addressing — ${e instanceof Error ? e.message : String(e)}`);
      }
      for (const s of snapshotAllSessions()) {
        const n = s.paiName ?? s.name;
        if (n) names.push(n);
      }
      return names;
    },
  });

  // Prune stale image contexts every 5 minutes (30-minute TTL enforced inside)
  setInterval(() => {
    const evicted = pruneStaleContexts();
    if (evicted > 0) log(`[hub] pruned ${evicted} stale image context(s)`);
  }, 5 * 60 * 1000).unref();

  // Comment mirroring is driven by the write, not by a poll: `todoist_reply`
  // files the mirror entry itself, because we know the comment at the moment we
  // create it. Todoist stays silent only about the account's OWN activity, and
  // the bridge writes as the account — so the comments that need mirroring are
  // exactly the ones we produce. Everyone else's, Todoist already notifies for.
  //
  // The activity-log sweep survives as an OPT-IN reconciliation for people who
  // also want comments written from other clients mirrored. Off by default: a
  // poll nobody asked for is a five-minute delay and a token refresh storm, both
  // of which this system has now demonstrated.
  {
    const minutes = Number(process.env.TODOIST_MIRROR_POLL_MINUTES ?? "0");
    if (Number.isFinite(minutes) && minutes > 0) {
      const runMirror = () => {
        void import("./todoist-mirror.js")
          .then((m) => (m.mirrorProjectId() ? m.syncMirror() : undefined))
          .catch((e) => log(`todoist-mirror: sync failed — ${e instanceof Error ? e.message : String(e)}`));
      };
      setTimeout(runMirror, 20_000).unref();
      setInterval(runMirror, minutes * 60 * 1000).unref();
      log(`todoist-mirror: reconciliation sweep every ${minutes} min (TODOIST_MIRROR_POLL_MINUTES)`);
    }
  }

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

    // APNs device token registration — app publishes on pailot/device/token
    if (type === "apns_token") {
      const token = payload.token as string | undefined;
      if (token) {
        apnsRegisterToken(token);
      }
      return;
    }

    if (type === "command") {
      const command = (payload.command as string) ?? "";

      // App trace log — stream to daemon log for remote debugging
      if (command === "app_trace") {
        const event = (payload.event as string) ?? "?";
        const details = (payload.details as string) ?? "";
        log(`[APP] ${event}: ${details}`);
        return;
      }

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

    // Validate against the live session list. A stale id (e.g. a Claude Code
    // session was restarted and got a new id) would otherwise be passed to the
    // bridge, where the lower transports silently fall back to the active
    // session — landing the message in the wrong tab. Refuse to route, push a
    // fresh session list, and tell the user.
    const knownSession = manager.listSessions().some(s => s.backendSessionId === routeSession);
    if (!knownSession) {
      log(`[MQTT→Hub] Rejecting ${type} — sessionId=${routeSession.slice(0, 8)} is stale (no matching session). Refreshing client list.`);
      mqttPublishControl({ type: "session_not_found", sessionId: routeSession });
      handleMqttCommand("sessions");
      mqttPublishText(routeSession, "⚠️ That session no longer exists on the host. Pick a session from the refreshed list and resend.");
      return;
    }

    if (type === "text") {
      const content = (payload.content as string) ?? "";
      if (!content.trim()) return;
      log(`[MQTT→Hub] text from session ${routeSession.slice(0, 8)}...`);
      // Publish typing indicator so the app shows 3 dots while waiting for response
      mqttPublishTyping(routeSession, true);
      bridge.routeFromMobile(routeSession, content);
    } else if (type === "voice" && payload.audioBase64) {
      log(`[MQTT→Hub] voice from session ${routeSession.slice(0, 8)}...`);
      // Publish typing indicator so the app shows 3 dots while waiting for response
      mqttPublishTyping(routeSession, true);
      const msgId = typeof payload.messageId === "string" ? payload.messageId : undefined;
      // Set routing session before transcription — capture for batch flush
      setLastRoutedSessionId(routeSession!);
      setActiveItermSessionId(routeSession!);
      setVoiceBatchSession(routeSession!);
      transcribeAndRoute(
        payload.audioBase64 as string,
        (_text: string, _ts: number) => { /* onMessage not needed for MQTT path */ },
        msgId,
      ).catch((err) => log(`[MQTT→Hub] voice transcription error: ${err}`));
    } else if (type === "image" && payload.imageBase64) {
      const caption = (payload.caption as string) ?? "";
      const mime = ((payload.mimeType as string) ?? "image/jpeg").toLowerCase();
      const imgBuf = Buffer.from(payload.imageBase64 as string, "base64");
      const ext = mime.includes("png") ? "png" : "jpg";
      const imgPath = join(tmpdir(), `pailot-img-${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`);
      writeFileSync(imgPath, imgBuf);
      log(`[MQTT→Hub] image saved (${imgBuf.length} bytes) → ${imgPath}`);
      const routeText = caption ? `${caption} (image at ${imgPath})` : `(image at ${imgPath})`;
      setLastRoutedSessionId(routeSession!);
      bridge.routeFromMobile(routeSession, routeText);
    } else if (type === "file" && payload.fileBase64) {
      const fileName = (payload.fileName as string) ?? "file";
      const fileBuf = Buffer.from(payload.fileBase64 as string, "base64");
      const filePath = join(tmpdir(), `pailot-file-${Date.now()}-${fileName}`);
      writeFileSync(filePath, fileBuf);
      log(`[MQTT→Hub] file saved (${fileBuf.length} bytes) → ${filePath}`);
      setLastRoutedSessionId(routeSession!);
      bridge.routeFromMobile(routeSession, `${fileName} (file at ${filePath})`);
    } else if (type === "bundle") {
      // Atomic multi-attachment message: save all files, compose single text
      let caption = (payload.caption as string) ?? "";
      const audioBase64 = payload.audioBase64 as string | undefined;
      const attachments = (payload.attachments as Array<{ data: string; mimeType: string; fileName?: string }>) ?? [];

      mqttPublishTyping(routeSession!, true);
      setLastRoutedSessionId(routeSession!);
      setActiveItermSessionId(routeSession!);

      // Save all attachments to temp files
      const paths: string[] = [];
      for (let i = 0; i < attachments.length; i++) {
        const att = attachments[i];
        const buf = Buffer.from(att.data, "base64");
        const mime = (att.mimeType ?? "application/octet-stream").toLowerCase();
        const ext = mime.includes("png") ? "png" : mime.includes("pdf") ? "pdf" : mime.includes("image") ? "jpg" : "bin";
        const name = att.fileName ?? `attachment_${i + 1}.${ext}`;
        const filePath = join(tmpdir(), `pailot-${Date.now()}-${randomUUID().slice(0, 8)}-${name}`);
        writeFileSync(filePath, buf);
        paths.push(filePath);
        log(`[MQTT→Hub] bundle attachment ${i + 1}/${attachments.length}: ${name} (${buf.length} bytes) → ${filePath}`);
      }

      // If voice caption, transcribe directly (bypass voice batch to keep file paths)
      if (audioBase64) {
        const voiceMessageId = payload.voiceMessageId as string | undefined;
        log(`[MQTT→Hub] bundle has voice — transcribing before delivery (msgId=${voiceMessageId?.slice(0, 8) ?? "none"})`);
        setLastRoutedSessionId(routeSession!);
        setActiveItermSessionId(routeSession!);
        const fileParts = paths.map(p => `(file at ${p})`).join(" ");
        void (async () => {
          try {
            const { transcribeAudio } = await import("../adapters/kokoro/media.js");
            const audioPath = join(tmpdir(), `pailot-bundle-voice-${Date.now()}.m4a`);
            writeFileSync(audioPath, Buffer.from(audioBase64, "base64"));
            const rawTranscript = await transcribeAudio(audioPath, "");
            const text = rawTranscript?.replace(/^[\s:]+/, "").trim() ?? "";
            // Reflect transcript to app
            if (voiceMessageId) {
              const { mqttPublishTranscript } = await import("../adapters/pailot/mqtt-broker.js");
              mqttPublishTranscript(voiceMessageId, text, routeSession);
            }
            const routeText = text ? `[PAILot:voice] ${text} ${fileParts}` : fileParts;
            log(`[MQTT→Hub] bundle delivering: ${routeText.slice(0, 100)}`);
            bridge.routeFromMobile(routeSession!, routeText);
          } catch (err) {
            log(`[MQTT→Hub] bundle voice transcription error: ${err}`);
            bridge.routeFromMobile(routeSession!, fileParts);
          }
        })();
      } else {
        // Text caption only — deliver immediately
        const fileParts = paths.map(p => `(file at ${p})`).join(" ");
        const routeText = caption ? `${caption} ${fileParts}` : fileParts;
        bridge.routeFromMobile(routeSession!, routeText);
      }
    }
  });
  loadQueue();
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
    flushQueue();
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
