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
import { tmpdir, homedir } from "node:os";

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
  lastRoutedSessionId,
  setLastRoutedSessionId,
} from "../../core/state.js";
import { setItermSessionVar, setItermTabName, killSession, createClaudeSession } from "../iterm/sessions.js";
import { listPaiProjects, launchPaiProject } from "../../daemon/pai-projects.js";
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
/** Track when each client last proved it's alive (pong, message, or connect). */
const clientLastActive = new Map<WebSocket, number>();
/** Consider a client "alive" if it responded within this window. */
const CLIENT_ALIVE_THRESHOLD = 90_000; // 90s (3x the 30s heartbeat)

// --- Per-session message outbox for offline/backgrounded clients ---
// Buffers messages when no live client can receive them.
// Stored per-session so drain delivers to the correct session.
const MAX_OUTBOX_PER_SESSION = 50;
const OUTBOX_DIR = join(homedir(), ".aibroker", "outbox");

interface OutboxEntry {
  msg: Record<string, unknown>;
  timestamp: number;
}
const outboxMap = new Map<string, OutboxEntry[]>();  // sessionId → entries
let missedImageCount = 0;

function addToOutbox(msg: Record<string, unknown>): void {
  const type = msg.type as string;
  if (type === "typing") return;
  if (type === "image") { missedImageCount++; return; }

  const sessionId = (msg.sessionId as string) || "_global";
  let queue = outboxMap.get(sessionId);
  if (!queue) { queue = []; outboxMap.set(sessionId, queue); }
  queue.push({ msg, timestamp: Date.now() });
  if (queue.length > MAX_OUTBOX_PER_SESSION) queue.shift();

  // Persist to disk (best-effort, async)
  persistOutbox();
}

function drainOutbox(ws: WebSocket): void {
  // Collect all entries across all sessions
  let totalEntries = 0;
  let textCount = 0;
  let voiceCount = 0;
  for (const entries of outboxMap.values()) {
    totalEntries += entries.length;
    for (const e of entries) {
      const t = e.msg.type as string;
      if (t === "text") textCount++;
      else if (t === "voice") voiceCount++;
    }
  }
  if (totalEntries === 0 && missedImageCount === 0) return;

  const otherCount = totalEntries - textCount - voiceCount;
  const parts: string[] = [];
  if (textCount > 0) parts.push(`${textCount} text message(s)`);
  if (voiceCount > 0) parts.push(`${voiceCount} voice note(s)`);
  if (missedImageCount > 0) parts.push(`${missedImageCount} image(s)`);
  if (otherCount > 0) parts.push(`${otherCount} other`);

  sendTo(ws, {
    type: "text",
    content: `📬 While you were away: ${parts.join(", ")}`,
  });

  // Replay all buffered messages (sorted by timestamp across sessions)
  const allEntries: OutboxEntry[] = [];
  for (const entries of outboxMap.values()) allEntries.push(...entries);
  allEntries.sort((a, b) => a.timestamp - b.timestamp);
  for (const entry of allEntries) {
    sendTo(ws, entry.msg);
  }

  // Clear outbox
  outboxMap.clear();
  missedImageCount = 0;
  persistOutbox();
}

/** Persist outbox to disk so daemon restarts don't lose messages. */
function persistOutbox(): void {
  try {
    const { mkdirSync, writeFileSync: writeSync } = require("node:fs");
    mkdirSync(OUTBOX_DIR, { recursive: true });
    const data: Record<string, OutboxEntry[]> = {};
    for (const [k, v] of outboxMap) data[k] = v;
    writeSync(join(OUTBOX_DIR, "pending.json"), JSON.stringify({ messages: data, missedImageCount }));
  } catch { /* best-effort */ }
}

/** Restore outbox from disk on startup. */
function restoreOutbox(): void {
  try {
    const path = join(OUTBOX_DIR, "pending.json");
    if (!existsSync(path)) return;
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw);
    if (data.messages) {
      for (const [k, v] of Object.entries(data.messages)) {
        outboxMap.set(k, v as OutboxEntry[]);
      }
    }
    if (data.missedImageCount) missedImageCount = data.missedImageCount;
    log(`[PAILot] Restored ${outboxMap.size} outbox queue(s) from disk`);
    // Clean up the file after restoring
    unlinkSync(path);
  } catch { /* ignore */ }
}

function isClientAlive(ws: WebSocket): boolean {
  if (ws.readyState !== WebSocket.OPEN) return false;
  const lastActive = clientLastActive.get(ws) ?? 0;
  return (Date.now() - lastActive) < CLIENT_ALIVE_THRESHOLD;
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
    drainOutbox(ws);
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
      drainOutbox(ws);
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

  // Return sessions with updated active state, then drain buffered messages
  handleSessionsCommand(ws);
  drainOutbox(ws);
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

function handleCreateCommand(ws: WebSocket, args: Record<string, unknown> = {}): void {
  const projectName = args.project as string | undefined;
  const path = args.path as string | undefined;

  // PAI project launch — async path
  if (projectName) {
    handleCreateFromProject(ws, projectName);
    return;
  }

  // Custom path — cd then claude
  const command = path ? `cd ${path.replace(/"/g, '\\"')} && claude` : "claude";
  const name = path ? path.split("/").filter(Boolean).pop() ?? "Claude" : "Claude";

  const sessionId = createClaudeSession(command);
  if (!sessionId) {
    sendTo(ws, { type: "error", message: "Failed to create new session" });
    return;
  }

  setItermSessionVar(sessionId, name);
  setItermTabName(sessionId, name);

  if (hybridManager) {
    hybridManager.registerVisualSession(name, "", sessionId);
    const sessions = hybridManager.listSessions();
    const idx = sessions.findIndex(s => s.backendSessionId === sessionId);
    if (idx >= 0) {
      hybridManager.switchToIndex(idx + 1);
      setActiveItermSessionId(sessionId);
    }
  }

  log(`[PAILot] created new session "${name}" (${sessionId.slice(0, 8)}...)`);
  sendTo(ws, { type: "session_switched", name, sessionId });
  handleSessionsCommand(ws);
}

async function handleCreateFromProject(ws: WebSocket, projectName: string): Promise<void> {
  try {
    const { itermSessionId } = await launchPaiProject(projectName);
    const displayName = projectName;

    if (hybridManager) {
      hybridManager.registerVisualSession(displayName, "", itermSessionId);
      const sessions = hybridManager.listSessions();
      const idx = sessions.findIndex(s => s.backendSessionId === itermSessionId);
      if (idx >= 0) {
        hybridManager.switchToIndex(idx + 1);
        setActiveItermSessionId(itermSessionId);
      }
    }

    log(`[PAILot] launched PAI project "${projectName}" (${itermSessionId.slice(0, 8)}...)`);
    sendTo(ws, { type: "session_switched", name: displayName, sessionId: itermSessionId });
    handleSessionsCommand(ws);
  } catch (err) {
    log(`[PAILot] project launch failed: ${err}`);
    sendTo(ws, { type: "error", message: `Failed to launch project: ${err instanceof Error ? err.message : String(err)}` });
  }
}

async function handleProjectsCommand(ws: WebSocket): Promise<void> {
  try {
    const projects = await listPaiProjects();
    const list = projects.map(p => ({
      name: p.displayName || p.name,
      slug: p.slug,
      path: p.rootPath,
      sessions: p.sessionCount,
    }));
    sendTo(ws, { type: "projects", projects: list });
  } catch (err) {
    log(`[PAILot] projects list failed: ${err}`);
    sendTo(ws, { type: "projects", projects: [] });
  }
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
  // Only deliver to clients that have proven liveness recently.
  // iOS can keep a WebSocket "open" while the app is backgrounded —
  // ws.send() succeeds but the app never processes the data.
  let delivered = false;
  const payload = JSON.stringify(msg);
  for (const ws of clients) {
    if (isClientAlive(ws)) {
      ws.send(payload);
      delivered = true;
    }
  }
  // No live clients — buffer for later
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
    setLastRoutedSessionId(activeItermSessionId);
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

  // Restore any buffered messages from a previous daemon run
  restoreOutbox();

  wss.on("listening", () => {
    log(`WebSocket gateway listening on ws://0.0.0.0:${WS_PORT}`);

    // Pre-populate hybrid manager with live iTerm sessions so messages
    // can be tagged with sessionId even before a PAILot client connects.
    if (hybridManager) {
      try {
        const liveSnapshots = snapshotAllSessions();
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
        // Also set the active session based on current iTerm focus
        const focusedId = runAppleScript(`tell application "iTerm2"
  try
    return id of current session of current tab of current window
  on error
    return ""
  end try
end tell`)?.trim() ?? "";
        if (focusedId) {
          const sessions = hybridManager.listSessions();
          const idx = sessions.findIndex(s => s.backendSessionId === focusedId);
          if (idx >= 0) {
            hybridManager.switchToIndex(idx + 1);
            setActiveItermSessionId(focusedId);
          }
        }
        log(`Pre-registered ${hybridManager.listSessions().length} session(s) from live iTerm`);
      } catch (err) {
        log(`Failed to pre-register sessions: ${err}`);
      }
    }
  });

  wss.on("connection", (ws, req) => {
    const addr = req.socket.remoteAddress ?? "unknown";
    log(`PAILot client connected from ${addr}`);
    clients.add(ws);
    clientLastActive.set(ws, Date.now());

    ws.on("message", (raw) => {
      clientLastActive.set(ws, Date.now());
      try {
        const rawStr = raw.toString();
        const msg = JSON.parse(rawStr);
        dbg(`RAW msg (${rawStr.length} chars): type=${msg.type}, hasAudio=${!!msg.audioBase64}, content=${(msg.content ?? "").slice(0, 50)}`);

        // Heartbeat ping — reply with pong immediately.
        // The clientLastActive update above already covers liveness.
        if (msg.type === "ping") {
          sendTo(ws, { type: "pong" });
          return;
        }

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
              handleCreateCommand(ws, args);
              return;
            case "projects":
              handleProjectsCommand(ws);
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
          broadcast({ type: "typing", typing: true, ...(activeItermSessionId && { sessionId: activeItermSessionId }) });
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
          setLastRoutedSessionId(activeItermSessionId);
          setMessageSource("pailot");
          onMessage(routeText, Date.now());
          setMessageSource("whatsapp");
          return;
        }

        // Plain text message — route through handleMessage
        const text = msg.content ?? "";
        if (!text.trim()) return;

        log(`[PAILot] ← ${text.slice(0, 80)}${text.length > 80 ? "..." : ""}`);

        broadcast({ type: "typing", typing: true, ...(activeItermSessionId && { sessionId: activeItermSessionId }) });
        setLastRoutedSessionId(activeItermSessionId);
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
      clientLastActive.delete(ws);
    });

    ws.on("error", (err) => {
      log(`[PAILot] WebSocket error: ${err.message}`);
      clients.delete(ws);
      clientLastActive.delete(ws);
    });

    // Welcome — outbox drains after client sends "sync" command
    // (so activeSessionId is set before messages arrive)
    sendTo(ws, { type: "text", content: "Connected to PAILot gateway." });
  });

  wss.on("error", (err) => {
    log(`WebSocket gateway error: ${err.message}`);
  });
}

/**
 * Broadcast a text message to all connected PAILot clients.
 * @param sessionId — iTerm session ID of the originating Claude session
 */
function resolveSessionId(sessionId?: string): string | undefined {
  if (sessionId) return sessionId;
  // Prefer the session that last received user input from PAILot —
  // this survives session switches that happen while Claude is thinking.
  if (lastRoutedSessionId) return lastRoutedSessionId;
  if (activeItermSessionId) return activeItermSessionId;
  // Last resort: ask hybrid manager for the active session's backend ID
  return hybridManager?.activeSession?.backendSessionId || undefined;
}

export function broadcastText(text: string, sessionId?: string): void {
  const resolvedSession = resolveSessionId(sessionId);
  broadcast({ type: "typing", typing: false, ...(resolvedSession && { sessionId: resolvedSession }) });
  broadcast({ type: "text", content: text, ...(resolvedSession && { sessionId: resolvedSession }) });
}

/**
 * Broadcast a voice note to all connected PAILot clients.
 * Converts OGG Opus to M4A (AAC) since iOS can't play OGG natively.
 * @param sessionId — iTerm session ID of the originating Claude session
 */
export async function broadcastVoice(audioBuffer: Buffer, transcript: string, sessionId?: string): Promise<void> {
  const resolvedSession = resolveSessionId(sessionId);
  broadcast({ type: "typing", typing: false, ...(resolvedSession && { sessionId: resolvedSession }) });
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
    ...(resolvedSession && { sessionId: resolvedSession }),
  });
}

/**
 * Broadcast a screenshot/image to all connected PAILot clients.
 * @param sessionId — iTerm session ID of the originating Claude session
 */
export function broadcastImage(imageBuffer: Buffer, caption?: string, sessionId?: string): void {
  const resolvedSession = resolveSessionId(sessionId);
  broadcast({
    type: "image",
    imageBase64: imageBuffer.toString("base64"),
    caption: caption ?? "Screenshot",
    ...(resolvedSession && { sessionId: resolvedSession }),
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
