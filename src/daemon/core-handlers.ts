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
import { createBrokerMessage } from "../types/broker.js";
import type { BrokerMessage } from "../types/broker.js";
import { broadcastStatus, broadcastVoice, broadcastImage, broadcastText } from "../adapters/pailot/gateway.js";
import { WatcherClient } from "../ipc/client.js";
import { saveVoiceConfig } from "../core/persistence.js";
import { voiceConfig, setVoiceConfig, activeItermSessionId, lastRoutedSessionId, getAibpBridge, depositToSessionMailbox, drainSessionMailbox } from "../core/state.js";
import { splitIntoChunks } from "../adapters/kokoro/media.js";
import { stripMarkdown } from "../core/markdown.js";
import { listPaiProjects, findPaiProject, launchPaiProject } from "./pai-projects.js";
import { readSessionContent, readAllSessionContent } from "./session-content.js";
import { statusCache, hashContent } from "../core/status-cache.js";
import { snapshotAllSessions, typeIntoSession } from "../adapters/iterm/core.js";
import { setItermSessionVar, setItermTabName, setItermBadge } from "../adapters/iterm/sessions.js";
import { log } from "../core/log.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getPackageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf-8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

const HUB_VERSION = getPackageVersion();

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
    const adapterHealth: Record<string, unknown> = {};
    for (const [name, health] of registry.getAllHealth()) {
      adapterHealth[name] = health;
    }
    return {
      ok: true,
      result: {
        version: HUB_VERSION,
        adapters: registry.list().map(a => a.name),
        activeSessions: manager.listSessions().length,
        activeSession: manager.activeSession?.name ?? null,
        adapterHealth,
      },
    };
  });

  /**
   * ping — Lightweight heartbeat for adapter health checks.
   * Returns immediately with the hub uptime. No side effects.
   */
  server.on("ping", async (_req) => {
    return { ok: true, result: { pong: true, uptime: process.uptime() } };
  });

  // ── TTS / Voice Pipeline ──

  /**
   * tts — Convert text to voice note and deliver to requesting adapter.
   *
   * The hub generates the audio (Kokoro TTS) and sends the OGG buffer
   * back to the adapter that requested it (via the "source" field).
   */
  server.on("tts", async (req) => {
    const { text, voice, source, recipient } = req.params as {
      text?: string;
      voice?: string;
      source?: string;
      recipient?: string;
    };
    if (!text) return { ok: false, error: "text is required" };

    const resolvedVoice = voice ?? voiceConfig.defaultVoice;

    try {
      const { textToVoiceNote } = await import("../adapters/kokoro/tts.js");
      const audioBuffer = await textToVoiceNote(text, resolvedVoice);

      // If a source adapter is specified, deliver the voice note through it
      if (source) {
        const adapter = registry.get(source);
        if (adapter) {
          const msg = createBrokerMessage("hub", "voice", {
            buffer: audioBuffer.toString("base64"),
            text: text.slice(0, 100),
            recipient,
            metadata: { voice: resolvedVoice },
          });
          await registry.deliverToAdapter(adapter, msg);
        }
      }

      // Also broadcast to PAILot clients
      const bridge = getAibpBridge();
      if (bridge) {
        bridge.routeToMobile("", text.slice(0, 200), "VOICE", {
          audioBase64: audioBuffer.toString("base64"),
        });
      } else {
        broadcastVoice(audioBuffer, text.slice(0, 200));
      }

      return { ok: true, result: { generated: true, voice: resolvedVoice, bytes: audioBuffer.length } };
    } catch (err) {
      return { ok: false, error: `TTS failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  /**
   * speak — Play text locally via afplay (no network delivery).
   */
  server.on("speak", async (req) => {
    const { text, voice } = req.params as { text?: string; voice?: string };
    if (!text) return { ok: false, error: "text is required" };

    try {
      const { speakLocally } = await import("../adapters/kokoro/tts.js");
      await speakLocally(text, voice ?? voiceConfig.defaultVoice);
      return { ok: true, result: { speaking: true } };
    } catch (err) {
      return { ok: false, error: `Speak failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  /**
   * dictate — Record from mic and transcribe via Whisper.
   */
  server.on("dictate", async (req) => {
    const { maxDuration } = req.params as { maxDuration?: number };

    try {
      const { recordFromMic, transcribeLocalAudio } = await import("../adapters/iterm/dictation.js");
      const audioPath = await recordFromMic(maxDuration ?? 30);
      const text = await transcribeLocalAudio(audioPath);
      return { ok: true, result: { text, audioPath } };
    } catch (err) {
      return { ok: false, error: `Dictation failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  /**
   * transcribe — Transcribe an audio buffer via Whisper.
   */
  server.on("transcribe", async (req) => {
    const { audioBase64, mimetype } = req.params as { audioBase64?: string; mimetype?: string };
    if (!audioBase64) return { ok: false, error: "audioBase64 is required" };

    try {
      const { transcribeAudio, mimetypeToExt } = await import("../adapters/kokoro/media.js");
      const { writeFileSync, unlinkSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const ext = mimetypeToExt(mimetype ?? "audio/ogg");
      const tmpPath = join(tmpdir(), `aibroker-transcribe-${Date.now()}.${ext}`);
      writeFileSync(tmpPath, Buffer.from(audioBase64, "base64"));
      try {
        const text = await transcribeAudio(tmpPath);
        return { ok: true, result: { text } };
      } finally {
        try { unlinkSync(tmpPath); } catch { /* ignore */ }
      }
    } catch (err) {
      return { ok: false, error: `Transcription failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  /**
   * list_voices — List available TTS voices.
   */
  server.on("list_voices", async (_req) => {
    const { listVoices } = await import("../adapters/kokoro/tts.js");
    return { ok: true, result: { voices: listVoices() } };
  });

  // ── PAI Named Sessions ──

  server.on("pai_projects", async (_req) => {
    const projects = await listPaiProjects();
    return { ok: true, result: { projects } };
  });

  server.on("pai_find", async (req) => {
    const { name } = req.params as { name: string };
    if (!name) return { ok: false, error: "name is required" };
    const project = await findPaiProject(name);
    if (!project) return { ok: false, error: `Project "${name}" not found` };
    return { ok: true, result: { project } };
  });

  server.on("pai_launch", async (req) => {
    const { name } = req.params as { name: string };
    if (!name) return { ok: false, error: "name is required" };

    let itermSessionId: string;
    let sessionId: string;
    try {
      ({ itermSessionId, sessionId } = await launchPaiProject(name));
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    // Register the visual session with HybridSessionManager
    const project = await findPaiProject(name);
    const displayName = project?.displayName || project?.name || name;
    manager.registerVisualSession(displayName, project?.rootPath ?? "", itermSessionId);

    return { ok: true, result: { itermSessionId, sessionId, name } };
  });

  // ── Phase 6: Image Generation ──

  /**
   * generate_image — Generate an image from a text prompt.
   *
   * Optionally sends an "on it..." ack and delivers the generated image
   * back to the requesting adapter.
   */
  server.on("generate_image", async (req) => {
    const { prompt, source, recipient, ack, width, height } = req.params as {
      prompt?: string;
      source?: string;
      recipient?: string;
      ack?: boolean;
      width?: number;
      height?: number;
    };
    if (!prompt) return { ok: false, error: "prompt is required" };

    // Send "on it..." ack to the requesting adapter
    if (ack !== false && source) {
      const adapter = registry.get(source);
      if (adapter) {
        const ackMsg = createBrokerMessage("hub", "text", {
          text: "On it... generating your image.",
          recipient,
        });
        registry.deliverToAdapter(adapter, ackMsg).catch(() => {});
      }
    }

    try {
      const { generateImage } = await import("./image-gen/index.js");
      const result = await generateImage({ prompt, width, height });

      // Deliver image to requesting adapter
      if (source && result.images.length > 0) {
        const adapter = registry.get(source);
        if (adapter) {
          const imgMsg = createBrokerMessage("hub", "image", {
            buffer: result.images[0].toString("base64"),
            caption: prompt.slice(0, 200),
            recipient,
            metadata: { model: result.model, durationMs: result.durationMs },
          });
          await registry.deliverToAdapter(adapter, imgMsg);
        }
      }

      // Also broadcast to PAILot clients
      if (result.images.length > 0) {
        const bridge = getAibpBridge();
        if (bridge) {
          bridge.routeToMobile("", prompt.slice(0, 200), "IMAGE", {
            imageBase64: result.images[0].toString("base64"),
            mimeType: "image/png",
          });
        } else {
          broadcastImage(result.images[0], prompt.slice(0, 200));
        }
      }

      return {
        ok: true,
        result: {
          generated: true,
          model: result.model,
          durationMs: result.durationMs,
          imageCount: result.images.length,
          bytes: result.images.reduce((s, b) => s + b.length, 0),
        },
      };
    } catch (err) {
      return { ok: false, error: `Image generation failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  // ── Phase 7: Vision & Understanding ──

  /**
   * analyze_image — Save image and deliver to active Claude Code session.
   *
   * The image is saved to ~/.aibroker/media/ and the path is routed through
   * the command handler to the active iTerm2 session. Claude Code in that
   * session reads the image with its Read tool (covered by Max plan).
   */
  server.on("analyze_image", async (req) => {
    const { imageBase64, mimetype, prompt, source, recipient } = req.params as {
      imageBase64?: string;
      mimetype?: string;
      prompt?: string;
      source?: string;
      recipient?: string;
    };
    if (!imageBase64) return { ok: false, error: "imageBase64 is required" };

    try {
      const { saveReceivedImage } = await import("./vision.js");
      const imageBuffer = Buffer.from(imageBase64, "base64");
      const { path, sizeBytes } = saveReceivedImage(imageBuffer, mimetype);

      // Route through the command handler → active iTerm2 session
      const userPrompt = prompt ?? "Analyze this image.";
      const messageText = `[Image: ${path}] ${userPrompt}`;

      const sourceAdapter = source ? registry.get(source) : undefined;
      const msg = createBrokerMessage(source ?? "hub", "command", {
        text: messageText,
        recipient,
      });
      await registry.route(msg);

      return { ok: true, result: { saved: true, path, sizeBytes } };
    } catch (err) {
      return { ok: false, error: `Image analysis failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  /**
   * analyze_video — Analyze a video using Gemini 2.0 Flash (free tier).
   *
   * Video can't be read by Claude Code's Read tool, so we use Gemini's
   * native video understanding and deliver the text result back.
   */
  server.on("analyze_video", async (req) => {
    const { videoBase64, mimetype, prompt, source, recipient } = req.params as {
      videoBase64?: string;
      mimetype?: string;
      prompt?: string;
      source?: string;
      recipient?: string;
    };
    if (!videoBase64) return { ok: false, error: "videoBase64 is required" };

    // Ack — video analysis takes longer
    if (source) {
      const adapter = registry.get(source);
      if (adapter) {
        const ackMsg = createBrokerMessage("hub", "text", {
          text: "Analyzing your video...",
          recipient,
        });
        registry.deliverToAdapter(adapter, ackMsg).catch(() => {});
      }
    }

    try {
      const { analyzeVideo, saveReceivedVideo } = await import("./vision.js");

      const videoBuffer = Buffer.from(videoBase64, "base64");
      const { path } = saveReceivedVideo(videoBuffer, mimetype);
      const result = await analyzeVideo({ videoBuffer, mimetype, prompt });

      // Deliver the analysis text to the active session
      if (result.text) {
        const analysisText = `[Video analysis of ${path}]\n\n${result.text}`;
        const msg = createBrokerMessage(source ?? "hub", "command", {
          text: analysisText,
          recipient,
        });
        await registry.route(msg);
      }

      return { ok: true, result: { text: result.text, model: result.model, durationMs: result.durationMs, path } };
    } catch (err) {
      return { ok: false, error: `Video analysis failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  // ── Session Orchestration (Phase 1) ──

  /**
   * session_content — Read raw terminal content from iTerm2 sessions.
   *
   * If sessionId is provided, reads that specific session.
   * If omitted, reads all sessions. Returns raw content + busy/idle flag
   * + whether content has changed since last probe (via content hash).
   */
  server.on("session_content", async (req) => {
    const { sessionId, lines } = req.params as {
      sessionId?: string;
      lines?: number;
    };

    const lineCount = lines ?? 100;

    if (sessionId) {
      const content = readSessionContent(sessionId, lineCount);
      if (!content) return { ok: false, error: `Session ${sessionId} not found in iTerm2` };

      const contentHash = hashContent(content.content);
      const changed = statusCache.hasChanged(sessionId, contentHash);
      const cached = statusCache.get(sessionId);

      if (!changed) {
        statusCache.touch(sessionId);
      }

      return {
        ok: true,
        result: {
          session: {
            ...content,
            contentHash,
            changed,
            cachedSummary: cached?.summary ?? null,
            cachedAt: cached?.timestamp ?? null,
          },
        },
      };
    }

    // All sessions
    const contents = readAllSessionContent(lineCount);
    const sessions = contents.map((c) => {
      const contentHash = hashContent(c.content);
      const changed = statusCache.hasChanged(c.sessionId, contentHash);
      const cached = statusCache.get(c.sessionId);
      if (!changed) statusCache.touch(c.sessionId);

      return {
        ...c,
        contentHash,
        changed,
        cachedSummary: cached?.summary ?? null,
        cachedAt: cached?.timestamp ?? null,
      };
    });

    return { ok: true, result: { sessions } };
  });

  /**
   * cache_status — Store a parsed summary for a session.
   *
   * Called by the requesting session's AI after parsing raw terminal content.
   * The summary is cached with the content hash so future probes can skip parsing
   * if content hasn't changed.
   */
  server.on("cache_status", async (req) => {
    const { sessionId, sessionName, summary, contentHash, state } = req.params as {
      sessionId?: string;
      sessionName?: string;
      summary?: string;
      contentHash?: string;
      state?: "idle" | "busy" | "error" | "disconnected";
    };
    if (!sessionId) return { ok: false, error: "sessionId is required" };
    if (!summary) return { ok: false, error: "summary is required" };

    statusCache.set(sessionId, {
      sessionId,
      sessionName: sessionName ?? sessionId,
      timestamp: Date.now(),
      state: state ?? "idle",
      summary,
      contentHash: contentHash ?? "",
      lastProbeAt: Date.now(),
    });

    return { ok: true, result: { cached: true, sessionId } };
  });

  /**
   * get_cached_status — Retrieve cached session summaries without re-probing.
   *
   * If sessionId is provided, returns that session's cached snapshot.
   * If omitted, returns all cached snapshots.
   */
  server.on("get_cached_status", async (req) => {
    const { sessionId } = req.params as { sessionId?: string };

    if (sessionId) {
      const cached = statusCache.get(sessionId);
      if (!cached) return { ok: true, result: { snapshot: null } };
      return { ok: true, result: { snapshot: cached } };
    }

    return { ok: true, result: { snapshots: statusCache.getAll() } };
  });

  // ── AIBP Protocol Support ──

  /**
   * aibp_register — Register an MCP process as an AIBP plugin.
   * Called once when the MCP server starts. Returns the resolved session
   * so the MCP doesn't need TTY detection for routing.
   */
  server.on("aibp_register", async (req) => {
    const { pluginId, sessionEnvId } = req.params as {
      pluginId?: string;
      sessionEnvId?: string;
    };
    if (!pluginId) return { ok: false, error: "pluginId is required" };

    const bridge = getAibpBridge();
    if (!bridge) return { ok: false, error: "AIBP bridge not initialized" };

    const result = bridge.registerMcp(pluginId, sessionEnvId);
    return {
      ok: true,
      result: {
        address: result.address,
        resolvedSession: result.resolvedSession,
      },
    };
  });

  /**
   * aibp_send — Send a message from one session to another via AIBP.
   * Enables cross-session messaging: session A can send text to session B.
   */
  server.on("aibp_send", async (req) => {
    const { fromSession, toSession, content, type } = req.params as {
      fromSession?: string;
      toSession?: string;
      content?: string;
      type?: "TEXT" | "COMMAND";
    };
    if (!toSession) return { ok: false, error: "toSession is required" };
    if (!content) return { ok: false, error: "content is required" };

    const bridge = getAibpBridge();
    if (!bridge) return { ok: false, error: "AIBP bridge not initialized" };

    bridge.routeBetweenSessions(
      fromSession ?? "unknown",
      toSession,
      content,
      type ?? "TEXT",
    );
    return { ok: true, result: {} };
  });

  /**
   * aibp_status — Query AIBP registry state (plugins, channels, commands).
   */
  server.on("aibp_status", async () => {
    const bridge = getAibpBridge();
    if (!bridge) return { ok: false, error: "AIBP bridge not initialized" };

    // Build iTerm session ID → name lookup from HybridSessionManager
    const sessionNames = new Map<string, string>();
    for (const s of manager.listSessions()) {
      sessionNames.set(s.backendSessionId, s.name);
    }

    // Enrich plugin list with session names for MCP plugins
    const plugins = bridge.registry.listPlugins().map(p => {
      const info: Record<string, unknown> = {
        address: p.address,
        type: p.spec.type,
        name: p.spec.name,
      };
      // For MCP plugins, resolve the session name from the iTerm UUID
      if (p.spec.type === "mcp") {
        const sessionChannel = Array.from(p.joinedChannels).find(ch => ch.startsWith("session:"));
        if (sessionChannel) {
          const itermId = sessionChannel.slice(8);
          const sessionName = sessionNames.get(itermId);
          if (sessionName) info.sessionName = sessionName;
        }
      }
      return info;
    });

    // Session snapshots (iTerm sessions with idle/busy status)
    const snapshots = snapshotAllSessions();
    const sessions = snapshots.map((snap, i) => {
      const label = snap.paiName ?? snap.tabTitle ?? snap.name;
      const isActive = snap.id === activeItermSessionId;
      const cached = statusCache.get(snap.id);
      const hasFreshSummary = cached?.summary && Date.now() - cached.timestamp < 5 * 60 * 1000;
      return {
        index: i + 1,
        id: snap.id,
        name: label,
        atPrompt: snap.atPrompt,
        active: isActive,
        summary: hasFreshSummary ? cached!.summary : undefined,
      };
    });

    return {
      ok: true,
      result: {
        sessions,
        plugins,
        channels: bridge.registry.listChannels().map(ch => ({
          name: ch.channel,
          members: Array.from(ch.members),
          outboxSize: ch.outbox.length,
        })),
        commands: bridge.listCommands().map(c => ({
          name: c.name,
          owner: c.owner,
          description: c.spec?.description,
        })),
      },
    };
  });

  // ── Inter-Session Communication ──

  /**
   * send_to_session — Type a message into a target iTerm2 session.
   *
   * Resolves the target by:
   *   1. Number → session index (1-based) from snapshotAllSessions
   *   2. iTerm UUID (contains hyphens and matches length) → used directly
   *   3. String → case-insensitive match against paiName or session name
   *
   * Calls typeIntoSession which writes text + Enter into the session's stdin.
   */
  server.on("send_to_session", async (req) => {
    const { target, message } = req.params as { target?: string; message?: string };
    if (!target) return { ok: false, error: "target is required" };
    if (!message) return { ok: false, error: "message is required" };

    const snapshots = snapshotAllSessions();

    let itermSessionId: string | null = null;
    let resolvedName: string | null = null;

    const asNumber = parseInt(target, 10);
    if (!Number.isNaN(asNumber) && String(asNumber) === target.trim()) {
      // Numeric index (1-based)
      const snap = snapshots[asNumber - 1];
      if (snap) {
        itermSessionId = snap.id;
        resolvedName = snap.paiName ?? snap.name;
      }
    } else if (/^[0-9A-Fa-f-]{20,}$/.test(target)) {
      // Looks like an iTerm UUID — use directly if it exists
      const snap = snapshots.find((s) => s.id === target);
      if (snap) {
        itermSessionId = snap.id;
        resolvedName = snap.paiName ?? snap.name;
      } else {
        // Trust the caller — they may have a valid ID not yet in the snapshot
        itermSessionId = target;
        resolvedName = target;
      }
    } else {
      // Name match (case-insensitive, prefers paiName, falls back to session name)
      const lower = target.toLowerCase();
      const snap = snapshots.find(
        (s) => (s.paiName ?? s.name).toLowerCase().includes(lower),
      );
      if (snap) {
        itermSessionId = snap.id;
        resolvedName = snap.paiName ?? snap.name;
      }
    }

    if (!itermSessionId) {
      return {
        ok: false,
        error: `Session "${target}" not found. Available sessions: ${snapshots.map((s, i) => `${i + 1}:${s.paiName ?? s.name}`).join(", ")}`,
      };
    }

    // Resolve the sender's name for the mailbox "from" label.
    // Normalize "w0t0p0:UUID" → "UUID" before snapshot lookup.
    const rawSenderId = req.itermSessionId;
    const senderItermId = rawSenderId
      ? (rawSenderId.includes(":") ? rawSenderId.split(":").pop()! : rawSenderId)
      : undefined;
    const senderSnap = senderItermId
      ? snapshots.find((s) => s.id === senderItermId)
      : undefined;
    const senderLabel = senderSnap
      ? (senderSnap.paiName ?? senderSnap.name)
      : (senderItermId ?? req.sessionId ?? "unknown");

    // Deposit into the target session's mailbox (structured receive)
    depositToSessionMailbox(itermSessionId, senderLabel, message);

    // Prefix with session routing tag so the receiving Claude knows to route the response back
    // This is analogous to [Whazaa], [PAILot], [Telex] prefixes for other channels
    const prefixedMessage = `[Session:${senderLabel}] ${message}`;

    // Also type into the terminal (ensures text appears even if target isn't polling mailbox)
    const success = typeIntoSession(itermSessionId, prefixedMessage);
    if (!success) {
      return { ok: false, error: `Failed to type into session "${resolvedName}" (${itermSessionId})` };
    }

    return { ok: true, result: { sent: true, sessionId: itermSessionId, name: resolvedName } };
  });

  /**
   * session_mailbox_receive — Drain the calling session's message mailbox.
   *
   * Returns all pending messages deposited by send_to_session from other sessions.
   * The queue is cleared on read (drain semantics). Returns empty array if no messages.
   *
   * The caller's iTerm session ID is taken from req.itermSessionId (set by IPC server
   * from the session context) or from the explicit sessionId param as a fallback.
   *
   * iTerm2 session IDs in env vars have the form "w0t0p0:UUID". We normalize to just
   * the UUID so mailbox keys match snapshot IDs.
   */
  server.on("session_mailbox_receive", async (req) => {
    const { sessionId: explicitSessionId } = req.params as { sessionId?: string };
    const rawId = req.itermSessionId ?? explicitSessionId ?? req.sessionId;
    if (!rawId) {
      return { ok: false, error: "Cannot determine session ID — pass sessionId param or run inside an iTerm session" };
    }
    // Normalize "w0t0p0:UUID" → "UUID"
    const itermSessionId = rawId.includes(":") ? rawId.split(":").pop()! : rawId;
    const messages = drainSessionMailbox(itermSessionId);
    return { ok: true, result: { messages, sessionId: itermSessionId } };
  });

  // ── Unified MCP Support ──

  /**
   * adapter_call — Proxy an IPC call to a named adapter through the hub.
   * The unified MCP server uses this to reach adapter-specific methods
   * (send, receive, contacts, history, etc.) without knowing socket paths.
   */
  server.on("adapter_call", async (req) => {
    const { adapter, method, params } = req.params as {
      adapter: string;
      method: string;
      params?: Record<string, unknown>;
    };
    if (!adapter) return { ok: false, error: "adapter is required" };
    if (!method) return { ok: false, error: "method is required" };

    const desc = registry.get(adapter);
    if (!desc) {
      return { ok: false, error: `Adapter '${adapter}' not registered. Is the ${adapter} daemon running?` };
    }

    try {
      const client = new WatcherClient(desc.socketPath);
      const forwardParams: Record<string, unknown> = { ...(params ?? {}), sessionId: req.sessionId };
      if (req.itermSessionId) forwardParams.itermSessionId = req.itermSessionId;
      const result = await client.call_raw(method, forwardParams);
      return { ok: true, result };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: `adapter_call to ${adapter}.${method} failed: ${msg}` };
    }
  });

  /**
   * pailot_send — Send text or voice to PAILot app clients via WS gateway.
   */
  server.on("pailot_send", async (req) => {
    const { text, voice, voiceName, sessionId: callerSessionId } = req.params as {
      text?: string;
      voice?: boolean;
      voiceName?: string;
      sessionId?: string;
    };
    if (!text) return { ok: false, error: "text is required" };
    // MCP server may not have ITERM_SESSION_ID — fall back to session that last
    // received user input from PAILot (survives session switches during processing)
    const sessionId = callerSessionId || lastRoutedSessionId || activeItermSessionId || undefined;
    log(`[pailot_send] callerSession=${callerSessionId?.slice(0, 8) ?? "none"} lastRouted=${lastRoutedSessionId?.slice(0, 8) ?? "none"} activeIterm=${activeItermSessionId?.slice(0, 8) ?? "none"} → resolved=${sessionId?.slice(0, 8) ?? "none"}`);

    try {
      const bridge = getAibpBridge();
      if (voice) {
        const { textToVoiceNote } = await import("../adapters/kokoro/tts.js");
        const resolvedVoice = voiceName ?? voiceConfig.defaultVoice;
        const plainText = stripMarkdown(text);
        const chunks = splitIntoChunks(plainText);
        for (let i = 0; i < chunks.length; i++) {
          if (i > 0) await new Promise((r) => setTimeout(r, 1000));
          const audioBuffer = await textToVoiceNote(chunks[i], resolvedVoice);
          const transcript = i === 0 ? plainText : "";
          if (bridge) {
            bridge.routeToMobile(sessionId ?? "", transcript, "VOICE", {
              audioBase64: audioBuffer.toString("base64"),
            });
          } else {
            await broadcastVoice(audioBuffer, transcript, sessionId);
          }
        }
        return { ok: true, result: { sent: true, chunks: chunks.length } };
      } else {
        if (bridge) {
          bridge.routeToMobile(sessionId ?? "", text);
        } else {
          broadcastText(text, sessionId);
        }
      }
      return { ok: true, result: { sent: true } };
    } catch (e) {
      return { ok: false, error: `pailot_send failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  });

  /**
   * pailot_receive — Drain the PAILot message queue.
   * Currently proxied to whazaa adapter's receive with from='pailot'.
   */
  server.on("pailot_receive", async (req) => {
    const adapterName = registry.get("whazaa") ? "whazaa" : "telex";
    const desc = registry.get(adapterName);
    if (!desc) return { ok: true, result: { messages: [] } };

    try {
      const client = new WatcherClient(desc.socketPath);
      const result = await client.call_raw("receive", {
        from: "pailot",
        sessionId: req.sessionId,
      });
      return { ok: true, result };
    } catch {
      return { ok: true, result: { messages: [] } };
    }
  });

  /**
   * rename — Rename session: update registry, tab title, badge, and session variable.
   *
   * Resolves the caller's iTerm2 session from req.itermSessionId (set by IPC client
   * from ITERM_SESSION_ID env var). This works for both MCP callers (Claude Code sessions)
   * and adapter-forwarded renames.
   */
  server.on("rename", async (req) => {
    const { name } = req.params as { name: string };
    if (!name) return { ok: false, error: "name is required" };

    // Resolve caller's iTerm2 session UUID from "w0t0p0:UUID" format
    const rawItermId = req.itermSessionId;
    const itermSessionId = rawItermId
      ? (rawItermId.includes(":") ? rawItermId.split(":").pop()! : rawItermId)
      : undefined;

    // Update in hub's session manager
    if (itermSessionId) {
      // updateName searches by backendSessionId (iTerm2 UUID)
      manager.updateName(itermSessionId, name);
    } else {
      const session = manager.activeSession;
      if (session) manager.updateName(session.id, name);
    }

    // Set iTerm2 visuals directly if we know the session
    if (itermSessionId) {
      setItermSessionVar(itermSessionId, name);
      setItermTabName(itermSessionId, name);
      setItermBadge(itermSessionId, name);
    }

    // Forward to all adapters (best effort — for PAILot session list sync)
    for (const adapter of registry.list()) {
      try {
        const client = new WatcherClient(adapter.socketPath);
        await client.call_raw("rename", { name, sessionId: req.sessionId });
      } catch { /* best effort */ }
    }
    return { ok: true, result: { success: true, name } };
  });

  /**
   * discover — Proxy to first available adapter for iTerm2 session scan.
   */
  server.on("discover", async (req) => {
    const adapters = registry.list();
    if (adapters.length === 0) return { ok: false, error: "No adapters registered" };
    try {
      const client = new WatcherClient(adapters[0].socketPath);
      const result = await client.call_raw("discover", { sessionId: req.sessionId });
      return { ok: true, result };
    } catch (e) {
      return { ok: false, error: `discover failed: ${e instanceof Error ? e.message : String(e)}` };
    }
  });

  /**
   * command — Execute a slash command through the hub command handler.
   */
  server.on("command", async (req) => {
    const { text } = req.params as { text: string };
    if (!text) return { ok: false, error: "text is required" };

    // Try the hub's command handler first
    const adapters = registry.list();
    if (adapters.length > 0) {
      try {
        const client = new WatcherClient(adapters[0].socketPath);
        const result = await client.call_raw("command", { text, sessionId: req.sessionId });
        return { ok: true, result };
      } catch { /* fall through */ }
    }
    return { ok: true, result: { executed: true, command: text } };
  });

  // ── Phase 2: Message Routing ──

  /**
   * route_message — Adapters send messages to the hub for routing.
   *
   * The hub inspects the BrokerMessage target and type, then delivers
   * to the appropriate adapter via its IPC socket ("deliver" method).
   */
  server.on("route_message", async (req) => {
    const { message } = req.params as { message: BrokerMessage };
    if (!message || !message.source || !message.type) {
      return { ok: false, error: "Invalid BrokerMessage: source and type are required" };
    }
    const result = await registry.route(message);
    if (result.ok) {
      return { ok: true, result: result as unknown as Record<string, unknown> };
    }
    return { ok: false, error: result.error ?? "Routing failed" };
  });
}
