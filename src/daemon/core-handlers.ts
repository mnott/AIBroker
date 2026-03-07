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
import { voiceConfig, setVoiceConfig } from "../core/state.js";
import { listPaiProjects, findPaiProject, launchPaiProject } from "./pai-projects.js";
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
      broadcastVoice(audioBuffer, text.slice(0, 200));

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
      const { generateImage } = await import("./image-gen.js");
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
        broadcastImage(result.images[0], prompt.slice(0, 200));
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
    const { text, voice, voiceName } = req.params as {
      text?: string;
      voice?: boolean;
      voiceName?: string;
    };
    if (!text) return { ok: false, error: "text is required" };

    try {
      if (voice) {
        const { textToVoiceNote } = await import("../adapters/kokoro/tts.js");
        const resolvedVoice = voiceName ?? voiceConfig.defaultVoice;
        const audioBuffer = await textToVoiceNote(text, resolvedVoice);
        broadcastVoice(audioBuffer, text.slice(0, 200));
      } else {
        broadcastText(text);
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
   * rename — Rename session in hub + forward to all adapters.
   */
  server.on("rename", async (req) => {
    const { name } = req.params as { name: string };
    if (!name) return { ok: false, error: "name is required" };

    // Update in hub's session manager
    const session = manager.activeSession;
    if (session) manager.updateName(session.id, name);

    // Forward to all adapters (best effort)
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
