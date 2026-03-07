/**
 * adapters/pailot/gateway.ts — WebSocket gateway for PAILot app connections.
 *
 * Runs alongside any transport's watcher (Whazaa, Telex, etc.). When the
 * PAILot iOS app connects via WebSocket, incoming messages are routed through
 * the same handleMessage() path as the transport's native messages. Outbound
 * messages from Claude are broadcast to all connected clients.
 *
 * The gateway also supports structured commands (sessions, screenshot,
 * navigation keys) so the app can interact with the watcher without
 * going through text-based slash commands.
 */

import { WebSocketServer, WebSocket } from "ws";
import { join } from "node:path";
import { writeFileSync, readFileSync, existsSync, unlinkSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";

const DEBUG_LOG = process.env.PAILOT_DEBUG ? "/tmp/pailot-ws-debug.log" : null;
function dbg(msg: string): void {
  if (DEBUG_LOG) appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`);
}
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { log } from "../../core/log.js";
import { WHISPER_BIN, WHISPER_MODEL } from "../kokoro/media.js";
import {
  setMessageSource,
  activeItermSessionId,
  setActiveItermSessionId,
} from "../../core/state.js";
import { setItermSessionVar, setItermTabName, killSession, createClaudeSession } from "../iterm/sessions.js";
import { runAppleScript, sendKeystrokeToSession, sendEscapeSequenceToSession, pasteTextIntoSession, snapshotAllSessions } from "../iterm/core.js";
import { hybridManager } from "../../core/hybrid.js";

const WS_PORT = parseInt(process.env.PAILOT_PORT ?? "8765", 10);

/** Session data sent to PAILot app */
interface WsSession {
  index: number;
  name: string;
  type: "claude" | "terminal";
  kind: "api" | "visual";
  isActive: boolean;
  id: string;
}

// --- State ---

let wss: WebSocketServer | null = null;
const clients = new Set<WebSocket>();

// --- Message outbox for offline clients ---
// Buffers messages when no client is connected so they can be replayed on reconnect.
// Only text messages are buffered fully; voice/image are counted but not stored (too large).
const MAX_OUTBOX = 50;
interface OutboxEntry {
  msg: Record<string, unknown>;
  timestamp: number;
}
const outbox: OutboxEntry[] = [];
let missedVoiceCount = 0;
let missedImageCount = 0;

function addToOutbox(msg: Record<string, unknown>): void {
  const type = msg.type as string;
  // Skip typing indicators — not useful to replay
  if (type === "typing") return;
  // Count but don't buffer screenshots (very large, less important)
  if (type === "image") { missedImageCount++; return; }
  // Buffer text, voice, sessions, errors, etc.
  outbox.push({ msg, timestamp: Date.now() });
  if (outbox.length > MAX_OUTBOX) outbox.shift();
}

function drainOutbox(ws: WebSocket): void {
  if (outbox.length === 0 && missedVoiceCount === 0 && missedImageCount === 0) return;

  // Send a summary of what was missed
  const textCount = outbox.filter(e => (e.msg.type as string) === "text").length;
  const voiceCount = outbox.filter(e => (e.msg.type as string) === "voice").length;
  const otherCount = outbox.length - textCount - voiceCount;
  const parts: string[] = [];
  if (textCount > 0) parts.push(`${textCount} text message(s)`);
  if (voiceCount > 0) parts.push(`${voiceCount} voice note(s)`);
  if (missedImageCount > 0) parts.push(`${missedImageCount} image(s)`);
  if (otherCount > 0) parts.push(`${otherCount} other`);

  sendTo(ws, {
    type: "text",
    content: `📬 While you were away: ${parts.join(", ")}`,
  });

  // Replay buffered text messages
  for (const entry of outbox) {
    sendTo(ws, entry.msg);
  }

  // Clear outbox
  outbox.length = 0;
  missedVoiceCount = 0;
  missedImageCount = 0;
}

// Reference to the screenshot handler — set via setScreenshotHandler()
// to avoid circular imports (screenshot.ts imports from state.ts which
// would create a cycle if we imported it here directly).
let screenshotHandler: ((source?: "whatsapp" | "pailot") => Promise<void>) | null = null;

/**
 * Provide the screenshot handler so ws-gateway can trigger screenshots
 * for navigation commands without a circular import.
 */
export function setScreenshotHandler(handler: (source?: "whatsapp" | "pailot") => Promise<void>): void {
  screenshotHandler = handler;
}

// --- Structured command handling ---

/**
 * Filter: include only Claude-related sessions.
 * A session qualifies if it has paiName, name contains "claude",
 * or is not at shell prompt (has a process running — likely Claude).
 */
function isClaudeRelated(snap: ReturnType<typeof snapshotAllSessions>[0]): boolean {
  if (snap.paiName) return true;
  const name = (snap.tabTitle ?? snap.name).toLowerCase();
  if (name.includes("claude")) return true;
  if (!snap.atPrompt) return true;
  return false;
}

/** Detect which iTerm2 session is currently focused and sync the hybrid manager to it.
 *  If the client passes activeSessionId, preserve that selection instead of
 *  jumping to whatever iTerm has focused on the Mac.
 */
function handleSyncCommand(ws: WebSocket, args?: Record<string, unknown>): void {
  if (!hybridManager) {
    handleSessionsCommand(ws);
    return;
  }

  const clientActiveId = typeof args?.activeSessionId === "string" ? args.activeSessionId : undefined;

  // Auto-discover Claude-related iTerm2 tabs so freshly-started daemons can match
  const liveSnapshots = snapshotAllSessions();
  const liveIds = new Set(liveSnapshots.map(s => s.id));
  hybridManager.pruneDeadVisualSessions(liveIds);
  const knownIds = new Set(hybridManager.listSessions().map(s => s.backendSessionId));
  const seenTabs = new Set<string>();
  for (const snap of liveSnapshots) {
    if (!isClaudeRelated(snap)) continue;
    const displayName = snap.tabTitle ?? snap.paiName ?? snap.name;
    if (seenTabs.has(displayName)) continue;
    seenTabs.add(displayName);
    if (!knownIds.has(snap.id)) {
      hybridManager.registerVisualSession(displayName, "", snap.id);
    }
  }

  // If the client had a session open, try to restore it
  if (clientActiveId) {
    const sessions = hybridManager.listSessions();
    const idx = sessions.findIndex(s => s.backendSessionId === clientActiveId);
    if (idx >= 0) {
      hybridManager.switchToIndex(idx + 1);
      setActiveItermSessionId(clientActiveId);
      log(`[PAILot] sync: restored client session "${sessions[idx].name}" (${clientActiveId.slice(0, 8)}...)`);
      handleSessionsCommand(ws);
      return;
    }
    // Client's session no longer exists — fall through to iTerm focus
  }

  // No client preference — ask iTerm2 which session is focused right now
  const focusedId = runAppleScript(`tell application "iTerm2"
  try
    return id of current session of current tab of current window
  on error
    return ""
  end try
end tell`)?.trim() ?? "";

  if (focusedId) {
    // Find this session in the hybrid manager and activate it
    const sessions = hybridManager.listSessions();
    const idx = sessions.findIndex(s => s.backendSessionId === focusedId);
    if (idx >= 0) {
      hybridManager.switchToIndex(idx + 1);
      setActiveItermSessionId(focusedId);
      log(`[PAILot] sync: activated focused session "${sessions[idx].name}" (${focusedId.slice(0, 8)}...)`);
    } else {
      log(`[PAILot] sync: focused session ${focusedId.slice(0, 8)}... not registered`);
    }
  }

  // Return sessions with updated active state
  handleSessionsCommand(ws);
}

function handleSessionsCommand(ws: WebSocket): void {
  if (!hybridManager) {
    sendTo(ws, { type: "sessions", sessions: [] });
    return;
  }

  // Prune visual sessions whose iTerm2 tabs have been closed
  const liveSnapshots = snapshotAllSessions();
  const liveIds = new Set(liveSnapshots.map(s => s.id));
  hybridManager.pruneDeadVisualSessions(liveIds);

  // Auto-discover Claude-related iTerm2 tabs not yet in the hybrid manager,
  // and sync names of existing sessions from live iTerm state.
  // Deduplicate by tab title — only register first session per tab.
  const knownIds = new Set(hybridManager.listSessions().map(s => s.backendSessionId));
  const seenTabs = new Set<string>();
  for (const snap of liveSnapshots) {
    if (!isClaudeRelated(snap)) continue;
    const displayName = snap.tabTitle ?? snap.paiName ?? snap.name;
    if (seenTabs.has(displayName)) continue; // skip split panes in same tab
    seenTabs.add(displayName);
    if (!knownIds.has(snap.id)) {
      hybridManager.registerVisualSession(displayName, "", snap.id);
    } else {
      // Sync name from iTerm (handles double-click renames)
      hybridManager.updateName(snap.id, displayName);
    }
  }

  const hybridSessions = hybridManager.listSessions();
  const active = hybridManager.activeSession;

  const sessions: WsSession[] = hybridSessions.map((s, i) => ({
    index: i + 1,
    name: s.name,
    type: "claude" as const,
    kind: s.kind,
    isActive: active ? s.id === active.id : false,
    id: s.backendSessionId,
  }));

  const payload = JSON.stringify({ type: "sessions", sessions });
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(payload);
  }
}

function handleSwitchCommand(ws: WebSocket, args: Record<string, unknown>): void {
  const sessionIndex = args.index as number | undefined;
  const sessionId = args.sessionId as string | undefined;
  const newName = args.name as string | undefined;

  if (!hybridManager) {
    sendTo(ws, { type: "error", message: "No session manager" });
    return;
  }

  // Resolve which session to switch to (prefer index, fall back to sessionId lookup)
  let targetIndex: number | undefined;
  if (sessionIndex) {
    targetIndex = sessionIndex;
  } else if (sessionId) {
    const sessions = hybridManager.listSessions();
    const idx = sessions.findIndex(s => s.backendSessionId === sessionId);
    if (idx >= 0) targetIndex = idx + 1;
  }

  if (!targetIndex) {
    sendTo(ws, { type: "error", message: "Missing session index or ID" });
    return;
  }

  const session = hybridManager.switchToIndex(targetIndex);
  if (!session) {
    sendTo(ws, { type: "error", message: "Session not found — it may have closed." });
    return;
  }

  // For visual sessions, also focus the iTerm2 tab
  if (session.kind === "visual") {
    setActiveItermSessionId(session.backendSessionId);
    const escapedId = session.backendSessionId.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    runAppleScript(`tell application "iTerm2"
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      repeat with aSession in sessions of aTab
        if id of aSession is "${escapedId}" then
          select aSession
          return "focused"
        end if
      end repeat
    end repeat
  end repeat
end tell`);
  }

  if (newName) {
    session.name = newName;
    if (session.kind === "visual") {
      setItermSessionVar(session.backendSessionId, newName);
      setItermTabName(session.backendSessionId, newName);
    }
  }

  sendTo(ws, { type: "session_switched", name: session.name, sessionId: session.backendSessionId });
  log(`[PAILot] switched to ${session.kind} session "${session.name}" (${session.id})`);
}

function handleRenameCommand(ws: WebSocket, args: Record<string, unknown>): void {
  const sessionId = args.sessionId as string | undefined;
  const name = args.name as string | undefined;

  if (!sessionId || !name || !hybridManager) {
    sendTo(ws, { type: "error", message: "Missing sessionId or name" });
    return;
  }

  // Find the hybrid session by backendSessionId
  const sessions = hybridManager.listSessions();
  const session = sessions.find(s => s.backendSessionId === sessionId);
  if (session) {
    session.name = name;
    if (session.kind === "visual") {
      setItermSessionVar(sessionId, name);
      setItermTabName(sessionId, name);
    }
  }

  sendTo(ws, { type: "session_renamed", sessionId, name });
  // Send updated sessions list so PAILot refreshes the header
  handleSessionsCommand(ws);
  log(`[PAILot] renamed session ${sessionId} to "${name}"`);
}

function handleRemoveCommand(ws: WebSocket, args: Record<string, unknown>): void {
  const sessionId = args.sessionId as string | undefined;

  if (!sessionId || !hybridManager) {
    sendTo(ws, { type: "error", message: "Missing sessionId" });
    return;
  }

  // Find session by backendSessionId
  const sessions = hybridManager.listSessions();
  const idx = sessions.findIndex(s => s.backendSessionId === sessionId);
  if (idx < 0) {
    sendTo(ws, { type: "error", message: "Session not found" });
    return;
  }

  const target = sessions[idx];
  // Kill the iTerm2 session if it's visual
  if (target.kind === "visual" && target.backendSessionId) {
    killSession(target.backendSessionId);
  }
  const removed = hybridManager.removeByIndex(idx + 1);
  if (removed) {
    log(`[PAILot] removed ${removed.kind} session "${removed.name}" (${removed.id})`);
  }

  // Send updated session list
  handleSessionsCommand(ws);
}

function handleCreateCommand(ws: WebSocket): void {
  const sessionId = createClaudeSession();
  if (!sessionId) {
    sendTo(ws, { type: "error", message: "Failed to create new session" });
    return;
  }

  // Tag it with paiName so it shows up in filtering
  setItermSessionVar(sessionId, "Claude");
  setItermTabName(sessionId, "Claude");

  // Register in hybrid manager
  if (hybridManager) {
    hybridManager.registerVisualSession("Claude", "", sessionId);
    // Switch to the new session
    const sessions = hybridManager.listSessions();
    const idx = sessions.findIndex(s => s.backendSessionId === sessionId);
    if (idx >= 0) {
      hybridManager.switchToIndex(idx + 1);
      setActiveItermSessionId(sessionId);
    }
  }

  log(`[PAILot] created new Claude session (${sessionId.slice(0, 8)}...)`);
  sendTo(ws, { type: "session_switched", name: "Claude", sessionId });
  handleSessionsCommand(ws);
}

async function handleNavCommand(ws: WebSocket, args: Record<string, unknown>): Promise<void> {
  const key = args.key as string | undefined;
  if (!key) return;

  // Guard: nav commands only work with visual sessions
  if (hybridManager?.activeSession?.kind === "api") {
    sendTo(ws, { type: "error", message: "Keyboard commands need a visual session." });
    return;
  }

  const targetSession = activeItermSessionId;
  if (!targetSession) {
    sendTo(ws, { type: "error", message: "No active session" });
    return;
  }

  // Map key names to actions
  // sendKeystrokeToSession takes ASCII code: 13=enter, 9=tab, 27=escape
  // sendEscapeSequenceToSession takes ANSI direction char: A=up, B=down, C=right, D=left
  const keyMap: Record<string, () => void> = {
    up: () => sendEscapeSequenceToSession(targetSession, "A"),
    down: () => sendEscapeSequenceToSession(targetSession, "B"),
    left: () => sendEscapeSequenceToSession(targetSession, "D"),
    right: () => sendEscapeSequenceToSession(targetSession, "C"),
    enter: () => sendKeystrokeToSession(targetSession, 13),
    tab: () => sendKeystrokeToSession(targetSession, 9),
    escape: () => sendKeystrokeToSession(targetSession, 27),
    "ctrl-c": () => {
      // Send Ctrl+C (ETX, ASCII 3)
      runAppleScript(`tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if id of s is "${targetSession}" then
          tell s to write text (ASCII character 3)
          return
        end if
      end repeat
    end repeat
  end repeat
end tell`);
    },
  };

  const action = keyMap[key];
  if (action) {
    action();
  } else {
    // Fallback: send as literal text (vi keys like "dd", "0", "G", etc.)
    pasteTextIntoSession(targetSession, key);
  }
  log(`[PAILot] nav: sent ${key} to session ${targetSession.slice(0, 8)}...`);

  // Auto-screenshot after navigation key with a brief delay for render
  if (screenshotHandler) {
    await new Promise((r) => setTimeout(r, 600));
    await triggerScreenshotForPailot();
  }
}

async function triggerScreenshotForPailot(): Promise<void> {
  if (!screenshotHandler) return;
  // Only send to PAILot — this is triggered by PAILot commands
  await screenshotHandler("pailot");
}

// --- Helpers ---

function sendTo(ws: WebSocket, msg: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcast(msg: Record<string, unknown>): void {
  // Check if any client is actually ready to receive
  let delivered = false;
  const payload = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(payload);
      delivered = true;
    }
  }
  // No connected clients — buffer for later
  if (!delivered) {
    addToOutbox(msg);
  }
}

// --- Voice message batching ---
// When multiple voice messages arrive within BATCH_WINDOW_MS, we combine their
// transcripts into a single onMessage call so Claude sees them as one input.

const BATCH_WINDOW_MS = 3000;
let voiceBatchTimer: ReturnType<typeof setTimeout> | null = null;
let voiceBatchTranscripts: string[] = [];
let voiceBatchOnMessage: ((text: string, timestamp: number) => void | Promise<void>) | null = null;

function flushVoiceBatch(): void {
  if (voiceBatchTranscripts.length === 0) return;
  const combined = voiceBatchTranscripts.join(" ");
  const handler = voiceBatchOnMessage;
  voiceBatchTranscripts = [];
  voiceBatchOnMessage = null;
  voiceBatchTimer = null;

  if (handler) {
    log(`[PAILot] Flushing voice batch (${combined.length} chars)`);
    setMessageSource("pailot");
    handler(`[PAILot:voice] ${combined}`, Date.now());
    setMessageSource("whatsapp");
  }
}

// --- Voice transcription for PAILot ---

const execFileAsync = promisify(execFile);

async function transcribeAndRoute(
  audioBase64: string,
  onMessage: (text: string, timestamp: number) => void | Promise<void>,
  messageId?: string,
): Promise<void> {
  const base = `pailot-voice-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const audioFile = join(tmpdir(), `${base}.m4a`);
  const filesToClean = [
    audioFile,
    join(tmpdir(), `${base}.txt`),
    join(tmpdir(), `${base}.json`),
    join(tmpdir(), `${base}.vtt`),
    join(tmpdir(), `${base}.srt`),
    join(tmpdir(), `${base}.tsv`),
  ];

  try {
    dbg(`transcribeAndRoute: base64 length=${audioBase64.length}`);
    const buffer = Buffer.from(audioBase64, "base64");
    writeFileSync(audioFile, buffer);
    dbg(`Audio saved: ${audioFile} (${buffer.length} bytes)`);
    log(`[PAILot] Voice note saved (${buffer.length} bytes), running Whisper...`);

    await execFileAsync(
      WHISPER_BIN,
      [audioFile, "--model", WHISPER_MODEL, "--output_format", "txt", "--output_dir", tmpdir(), "--verbose", "False"],
      {
        timeout: 120_000,
        env: {
          ...process.env,
          PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || "/usr/bin:/bin"}`,
        },
      }
    );

    const txtPath = join(tmpdir(), `${base}.txt`);
    if (!existsSync(txtPath)) {
      log(`[PAILot] Whisper did not produce output`);
      return;
    }

    const transcript = readFileSync(txtPath, "utf-8").trim();
    if (!transcript) {
      log(`[PAILot] Empty transcript`);
      return;
    }

    log(`[PAILot] Transcription: ${transcript.slice(0, 80)}${transcript.length > 80 ? "..." : ""}`);

    // Reflect transcript back to the app so the voice bubble shows text
    if (messageId) {
      broadcast({ type: "transcript", messageId, content: transcript });
    }

    // Batch: accumulate transcripts and reset the timer
    voiceBatchTranscripts.push(transcript);
    voiceBatchOnMessage = onMessage;
    if (voiceBatchTimer) clearTimeout(voiceBatchTimer);
    voiceBatchTimer = setTimeout(flushVoiceBatch, BATCH_WINDOW_MS);
  } catch (err) {
    log(`[PAILot] Whisper transcription failed: ${err}`);
  } finally {
    for (const f of filesToClean) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
  }
}

// --- Public API ---

/**
 * Start the WebSocket gateway.
 * @param onMessage — the same handleMessage(text, timestamp) used by the transport
 */
export function startWsGateway(onMessage: (text: string, timestamp: number) => void | Promise<void>): void {
  wss = new WebSocketServer({ port: WS_PORT });

  wss.on("listening", () => {
    log(`WebSocket gateway listening on ws://0.0.0.0:${WS_PORT}`);
  });

  wss.on("connection", (ws, req) => {
    const addr = req.socket.remoteAddress ?? "unknown";
    log(`PAILot client connected from ${addr}`);
    clients.add(ws);

    ws.on("message", (raw) => {
      try {
        const rawStr = raw.toString();
        const msg = JSON.parse(rawStr);
        dbg(`RAW msg (${rawStr.length} chars): type=${msg.type}, hasAudio=${!!msg.audioBase64}, content=${(msg.content ?? "").slice(0, 50)}`);

        // Structured commands from PAILot app
        if (msg.type === "command") {
          const command = msg.command as string;
          const args = (msg.args ?? {}) as Record<string, unknown>;
          log(`[PAILot] ← command: ${command}`);

          switch (command) {
            case "sessions":
              handleSessionsCommand(ws);
              return;
            case "sync":
              handleSyncCommand(ws, args);
              return;
            case "switch":
              handleSwitchCommand(ws, args);
              return;
            case "rename":
              handleRenameCommand(ws, args);
              return;
            case "remove":
              handleRemoveCommand(ws, args);
              return;
            case "create":
              handleCreateCommand(ws);
              return;
            case "screenshot":
              // For API sessions, send text status instead of screenshot
              if (hybridManager?.activeSession?.kind === "api") {
                const status = hybridManager.formatActiveStatus();
                if (status) {
                  sendTo(ws, { type: "text", content: status });
                }
              } else {
                triggerScreenshotForPailot().catch((err) => {
                  log(`[PAILot] screenshot error: ${err}`);
                });
              }
              return;
            case "nav":
              handleNavCommand(ws, args).catch((err) => {
                log(`[PAILot] nav error: ${err}`);
              });
              return;
            default:
              break;
          }
        }

        // Voice message — transcribe with Whisper then route
        if (msg.type === "voice" && msg.audioBase64) {
          dbg(`Voice message received, audioBase64 length: ${(msg.audioBase64 as string).length}`);
          broadcast({ type: "typing", typing: true });
          const voiceMsgId = typeof msg.messageId === "string" ? msg.messageId : undefined;
          transcribeAndRoute(msg.audioBase64 as string, onMessage, voiceMsgId).catch((err) => {
            log(`[PAILot] voice transcription error: ${err}`);
          });
          return;
        }

        // Image message — save to temp file, route caption as text
        // NOTE: Do NOT send the file path to Claude Code — it tries to read .jpg files
        // as images, which corrupts the conversation context with unprocessable image data.
        if (msg.type === "image" && msg.imageBase64) {
          const ext = (msg.mimeType ?? "image/jpeg").includes("png") ? "png" : "jpg";
          const imgPath = join(tmpdir(), `pailot-img-${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`);
          const imgBuf = Buffer.from(msg.imageBase64 as string, "base64");
          writeFileSync(imgPath, imgBuf);
          log(`[PAILot] Image saved (${imgBuf.length} bytes) → ${imgPath}`);
          const caption = (msg.caption as string) || "";
          // Embed the path inside parentheses so Claude Code doesn't auto-attach
          // the .jpg as an image (which corrupts the session if the API rejects it).
          // Claude can still use the Read tool to view it.
          const routeText = caption
            ? `${caption} (image at ${imgPath})`
            : `(image at ${imgPath})`;
          setMessageSource("pailot");
          onMessage(routeText, Date.now());
          setMessageSource("whatsapp");
          return;
        }

        // Plain text message — route through handleMessage
        const text = msg.content ?? "";
        if (!text.trim()) return;

        log(`[PAILot] ← ${text.slice(0, 80)}${text.length > 80 ? "..." : ""}`);

        broadcast({ type: "typing", typing: true });
        setMessageSource("pailot");
        onMessage(text, Date.now());
        setMessageSource("whatsapp");
      } catch {
        log(`[PAILot] Invalid message from ${addr}`);
      }
    });

    ws.on("close", () => {
      log(`PAILot client disconnected from ${addr}`);
      clients.delete(ws);
    });

    ws.on("error", (err) => {
      log(`[PAILot] WebSocket error: ${err.message}`);
      clients.delete(ws);
    });

    // Welcome + replay missed messages
    sendTo(ws, { type: "text", content: "Connected to PAILot gateway." });
    drainOutbox(ws);
  });

  wss.on("error", (err) => {
    log(`WebSocket gateway error: ${err.message}`);
  });
}

/**
 * Broadcast a text message to all connected PAILot clients.
 * @param sessionId — iTerm session ID of the originating Claude session
 */
export function broadcastText(text: string, sessionId?: string): void {
  broadcast({ type: "typing", typing: false });
  broadcast({ type: "text", content: text, ...(sessionId && { sessionId }) });
}

/**
 * Broadcast a voice note to all connected PAILot clients.
 * Converts OGG Opus to M4A (AAC) since iOS can't play OGG natively.
 * @param sessionId — iTerm session ID of the originating Claude session
 */
export async function broadcastVoice(audioBuffer: Buffer, transcript: string, sessionId?: string): Promise<void> {
  broadcast({ type: "typing", typing: false });
  let sendBuffer = audioBuffer;

  // Convert OGG Opus → M4A for iOS compatibility
  try {
    const uid = randomUUID().slice(0, 8);
    const oggPath = join(tmpdir(), `pailot-conv-${uid}.ogg`);
    const m4aPath = join(tmpdir(), `pailot-conv-${uid}.m4a`);
    writeFileSync(oggPath, audioBuffer);
    await execFileAsync("/opt/homebrew/bin/ffmpeg", [
      "-y", "-i", oggPath, "-c:a", "aac", "-b:a", "128k", m4aPath,
    ]);
    if (existsSync(m4aPath)) {
      sendBuffer = readFileSync(m4aPath);
      try { unlinkSync(oggPath); unlinkSync(m4aPath); } catch { /* ignore */ }
    }
  } catch (err) {
    log(`[PAILot] OGG→M4A conversion failed, sending raw: ${err}`);
  }

  broadcast({
    type: "voice",
    content: transcript,
    audioBase64: sendBuffer.toString("base64"),
    ...(sessionId && { sessionId }),
  });
}

/**
 * Broadcast a screenshot/image to all connected PAILot clients.
 * @param sessionId — iTerm session ID of the originating Claude session
 */
export function broadcastImage(imageBuffer: Buffer, caption?: string, sessionId?: string): void {
  broadcast({
    type: "image",
    imageBase64: imageBuffer.toString("base64"),
    caption: caption ?? "Screenshot",
    ...(sessionId && { sessionId }),
  });
}

/**
 * Broadcast a status change to all connected PAILot clients.
 * Used to signal compaction, reconnection, etc.
 */
export function broadcastStatus(status: string): void {
  broadcast({ type: "status", status });
}

/**
 * Returns true if any PAILot clients are connected.
 */
export function hasPailotClients(): boolean {
  return clients.size > 0;
}

/**
 * Stop the WebSocket gateway.
 */
export function stopWsGateway(): void {
  if (wss) {
    for (const ws of clients) ws.close();
    clients.clear();
    wss.close();
    wss = null;
  }
}
