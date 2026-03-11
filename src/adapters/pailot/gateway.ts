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
  getAibpBridge,
} from "../../core/state.js";
import { setItermSessionVar, setItermTabName, setItermBadge, killSession, createClaudeSession } from "../iterm/sessions.js";
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

/** Maps PAILot session ID → iTerm session ID for explicit reply routing.
 *  When PAILot sends a message tagged with sessionId, we record it here so
 *  outbound replies go back tagged with the same sessionId — regardless of
 *  which iTerm tab happens to be focused on the Mac at response time.
 */
const pailotReplyMap = new Map<string, string>();
/** Track which session each WebSocket client is currently viewing.
 *  Messages tagged with a different sessionId are NOT delivered to that client.
 *  This prevents cross-session content bleed in multi-session PAILot views.
 */
const clientActiveSession = new Map<WebSocket, string>();
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
  // Determine which session this client is currently viewing.
  // Only drain messages that match the client's session or have no session ID.
  const clientSession = clientActiveSession.get(ws);

  // Collect entries eligible for this client, leaving non-matching entries in place.
  const eligibleEntries: OutboxEntry[] = [];
  const remainingMap = new Map<string, OutboxEntry[]>();

  for (const [sessionKey, entries] of outboxMap.entries()) {
    const eligible: OutboxEntry[] = [];
    const remaining: OutboxEntry[] = [];
    for (const e of entries) {
      const msgSession = e.msg.sessionId as string | undefined;
      // Drain if: message has no session, client has no session, or sessions match
      if (!msgSession || !clientSession || msgSession === clientSession) {
        eligible.push(e);
      } else {
        remaining.push(e);
      }
    }
    eligibleEntries.push(...eligible);
    if (remaining.length > 0) remainingMap.set(sessionKey, remaining);
  }

  if (eligibleEntries.length === 0 && missedImageCount === 0) return;

  let textCount = 0;
  let voiceCount = 0;
  for (const e of eligibleEntries) {
    const t = e.msg.type as string;
    if (t === "text") textCount++;
    else if (t === "voice") voiceCount++;
  }
  const otherCount = eligibleEntries.length - textCount - voiceCount;
  const parts: string[] = [];
  if (textCount > 0) parts.push(`${textCount} text message(s)`);
  if (voiceCount > 0) parts.push(`${voiceCount} voice note(s)`);
  if (missedImageCount > 0) parts.push(`${missedImageCount} image(s)`);
  if (otherCount > 0) parts.push(`${otherCount} other`);

  sendTo(ws, {
    type: "text",
    content: `📬 While you were away: ${parts.join(", ")}`,
  });

  // Replay eligible buffered messages sorted by timestamp
  eligibleEntries.sort((a, b) => a.timestamp - b.timestamp);
  for (const entry of eligibleEntries) {
    sendTo(ws, entry.msg);
  }

  // Replace outbox with only the non-drained (session-mismatched) entries
  outboxMap.clear();
  for (const [k, v] of remainingMap) outboxMap.set(k, v);
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
    // First pass: check if it was already registered (by auto-discovery above or a prior sync)
    let sessions = hybridManager.listSessions();
    let idx = sessions.findIndex(s => s.backendSessionId === clientActiveId);

    // Second pass: the session may exist in liveSnapshots but wasn't registered because
    // isClaudeRelated() returned false (e.g. session is at a shell prompt between Claude runs
    // after a daemon restart). Since the client explicitly asked for this session by ID, register
    // it unconditionally if it is still alive in iTerm.
    if (idx < 0 && liveIds.has(clientActiveId)) {
      const snap = liveSnapshots.find(s => s.id === clientActiveId);
      if (snap) {
        const displayName = snap.tabTitle ?? snap.paiName ?? snap.name;
        hybridManager.registerVisualSession(displayName, "", clientActiveId);
        sessions = hybridManager.listSessions();
        idx = sessions.findIndex(s => s.backendSessionId === clientActiveId);
        log(`[PAILot] sync: force-registered client session "${displayName}" (${clientActiveId.slice(0, 8)}...)`);
      }
    }

    if (idx >= 0) {
      hybridManager.switchToIndex(idx + 1);
      setActiveItermSessionId(clientActiveId);
      setLastRoutedSessionId(clientActiveId);
      clientActiveSession.set(ws, clientActiveId);
      log(`[PAILot] sync: restored client session "${sessions[idx].name}" (${clientActiveId.slice(0, 8)}...)`);
      handleSessionsCommand(ws);
      drainOutbox(ws);
      return;
    }
    // Client's session no longer exists in iTerm — fall through to iTerm focus
    log(`[PAILot] sync: client session ${clientActiveId.slice(0, 8)}... not found in live iTerm — falling back to focused session`);
  }

  // No client preference (or client's session is gone) — ask iTerm2 which session is focused
  const focusedId = runAppleScript(`tell application "iTerm2"
  try
    return id of current session of current tab of current window
  on error
    return ""
  end try
end tell`)?.trim() ?? "";

  if (focusedId) {
    // Find this session in the hybrid manager and activate it.
    // If it wasn't registered by the Claude-related filter, register it now since the
    // user is actively looking at it.
    let sessions = hybridManager.listSessions();
    let idx = sessions.findIndex(s => s.backendSessionId === focusedId);
    if (idx < 0 && liveIds.has(focusedId)) {
      const snap = liveSnapshots.find(s => s.id === focusedId);
      if (snap) {
        const displayName = snap.tabTitle ?? snap.paiName ?? snap.name;
        hybridManager.registerVisualSession(displayName, "", focusedId);
        sessions = hybridManager.listSessions();
        idx = sessions.findIndex(s => s.backendSessionId === focusedId);
      }
    }
    if (idx >= 0) {
      hybridManager.switchToIndex(idx + 1);
      setActiveItermSessionId(focusedId);
      setLastRoutedSessionId(focusedId);
      clientActiveSession.set(ws, focusedId);
      log(`[PAILot] sync: activated focused session "${sessions[idx].name}" (${focusedId.slice(0, 8)}...)`);
    } else {
      log(`[PAILot] sync: focused session ${focusedId.slice(0, 8)}... not found in live iTerm`);
    }
  }

  // Last resort: if nothing is active yet but we have registered sessions, activate the first one
  if (!hybridManager.activeSession) {
    const sessions = hybridManager.listSessions();
    if (sessions.length > 0) {
      hybridManager.switchToIndex(1);
      setActiveItermSessionId(sessions[0].backendSessionId);
      setLastRoutedSessionId(sessions[0].backendSessionId);
      clientActiveSession.set(ws, sessions[0].backendSessionId);
      log(`[PAILot] sync: no focused session found — defaulting to first session "${sessions[0].name}"`);
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
      setItermBadge(session.backendSessionId, newName);
    }
  }

  // Record this as the last routed session so outbound replies go here,
  // regardless of which iTerm tab is focused on the Mac.
  setLastRoutedSessionId(session.backendSessionId);
  clientActiveSession.set(ws, session.backendSessionId);
  sendTo(ws, { type: "session_switched", name: session.name, sessionId: session.backendSessionId });
  log(`[PAILot] switched to ${session.kind} session "${session.name}" (${session.id})`);
  drainOutbox(ws);
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
      setItermBadge(sessionId, name);
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
  setItermBadge(sessionId, name);

  if (hybridManager) {
    hybridManager.registerVisualSession(name, "", sessionId);
    const sessions = hybridManager.listSessions();
    const idx = sessions.findIndex(s => s.backendSessionId === sessionId);
    if (idx >= 0) {
      hybridManager.switchToIndex(idx + 1);
      setActiveItermSessionId(sessionId);
      setLastRoutedSessionId(sessionId);
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
  //
  // Session filtering: if the message carries a sessionId, only deliver to
  // clients viewing that session. This prevents cross-session content bleed.
  // When a message is gated, notify live clients so they can show an unread badge.
  const msgSessionId = msg.sessionId as string | undefined;
  let delivered = false;
  let skippedDead = 0;
  let skippedSession = 0;
  const gatedClients: WebSocket[] = [];
  const payload = JSON.stringify(msg);
  for (const ws of clients) {
    if (!isClientAlive(ws)) { skippedDead++; continue; }
    // Session gate: if both the message and client have a session, they must match
    if (msgSessionId) {
      const clientSession = clientActiveSession.get(ws);
      if (clientSession && clientSession !== msgSessionId) {
        skippedSession++;
        gatedClients.push(ws);
        continue;
      }
    }
    ws.send(payload);
    delivered = true;
  }
  log(`[PAILot] broadcast type=${msg.type} session=${msgSessionId ?? "none"}: delivered=${delivered ? 1 : 0} skippedDead=${skippedDead} skippedSession=${skippedSession} outboxed=${!delivered}`);
  // No live clients received the message — buffer for later
  if (!delivered) {
    addToOutbox(msg);
  }
  // Notify live clients viewing other sessions about unread messages,
  // so the app can show a badge/indicator on that session in the drawer.
  if (!delivered && gatedClients.length > 0 && msg.type !== "typing") {
    const unreadNotification = JSON.stringify({
      type: "unread",
      sessionId: msgSessionId,
    });
    for (const ws of gatedClients) {
      ws.send(unreadNotification);
    }
  }
}

// --- Voice message batching ---
// When multiple voice messages arrive within BATCH_WINDOW_MS, we combine their
// transcripts into a single onMessage call so Claude sees them as one input.

const BATCH_WINDOW_MS = 3000;
let voiceBatchTimer: ReturnType<typeof setTimeout> | null = null;
let voiceBatchTranscripts: string[] = [];
let voiceBatchOnMessage: ((text: string, timestamp: number) => void | Promise<void>) | null = null;
/** iTerm session ID resolved when the first voice chunk of this batch arrived. */
let voiceBatchSessionId: string = "";

function flushVoiceBatch(): void {
  if (voiceBatchTranscripts.length === 0) return;
  const combined = voiceBatchTranscripts.join(" ");
  const handler = voiceBatchOnMessage;
  const batchSession = voiceBatchSessionId;
  voiceBatchTranscripts = [];
  voiceBatchOnMessage = null;
  voiceBatchSessionId = "";
  voiceBatchTimer = null;

  log(`[PAILot] Flushing voice batch (${combined.length} chars)`);
  const routeSession = batchSession || activeItermSessionId;
  if (routeSession) {
    pailotReplyMap.set(routeSession, routeSession);
    setLastRoutedSessionId(routeSession);
  }

  const bridge = getAibpBridge();
  if (bridge && routeSession) {
    bridge.routeFromMobile(routeSession, `[PAILot:voice] ${combined}`);
  } else if (handler) {
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

  // Server-side ping: keep connections alive and detect dead iOS clients.
  // iOS suspends backgrounded apps but keeps the TCP socket "open" — without
  // server pings, ws.readyState stays OPEN indefinitely even though the app is gone.
  const pingInterval = setInterval(() => {
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }
  }, 30_000);

  wss.on("close", () => {
    clearInterval(pingInterval);
  });

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

    ws.on("pong", () => {
      clientLastActive.set(ws, Date.now());
    });

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

        // Extract the session ID that PAILot says this message belongs to.
        // This is the iTerm session ID the user was viewing when they typed/spoke.
        // We use it for routing instead of guessing from activeItermSessionId.
        const pailotSessionId = typeof msg.sessionId === "string" ? msg.sessionId : undefined;

        // Helper: resolve the routing target for this message.
        // Prefers the explicit PAILot session ID; falls back to active session.
        const routeTarget = pailotSessionId || activeItermSessionId;

        // If PAILot told us the session, switch iTerm to it (for stdin routing)
        // and record it in the reply map so outbound replies go to the same session.
        if (pailotSessionId) {
          pailotReplyMap.set(pailotSessionId, pailotSessionId);
          setLastRoutedSessionId(pailotSessionId);
          // Switch iTerm to the correct session if it differs from the active one
          if (pailotSessionId !== activeItermSessionId) {
            setActiveItermSessionId(pailotSessionId);
            if (hybridManager) {
              const sessions = hybridManager.listSessions();
              const idx = sessions.findIndex(s => s.backendSessionId === pailotSessionId);
              if (idx >= 0) hybridManager.switchToIndex(idx + 1);
            }
          }
        }

        // Voice message — transcribe with Whisper then route
        if (msg.type === "voice" && msg.audioBase64) {
          dbg(`Voice message received, audioBase64 length: ${(msg.audioBase64 as string).length}`);
          broadcast({ type: "typing", typing: true, ...(routeTarget && { sessionId: routeTarget }) });
          const voiceMsgId = typeof msg.messageId === "string" ? msg.messageId : undefined;
          // Capture the routing session for this batch (first chunk wins)
          if (!voiceBatchSessionId && routeTarget) voiceBatchSessionId = routeTarget;
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
          if (!pailotSessionId) setLastRoutedSessionId(activeItermSessionId);

          const imgBridge = getAibpBridge();
          if (imgBridge && routeTarget) {
            imgBridge.routeFromMobile(routeTarget, routeText, "IMAGE", {
              imageBase64: msg.imageBase64 as string,
              mimeType: msg.mimeType ?? "image/jpeg",
            });
          } else {
            setMessageSource("pailot");
            onMessage(routeText, Date.now());
            setMessageSource("whatsapp");
          }
          return;
        }

        // Plain text message — route through AIBP bridge (or legacy fallback)
        const text = msg.content ?? "";
        if (!text.trim()) return;

        log(`[PAILot] ← ${text.slice(0, 80)}${text.length > 80 ? "..." : ""}`);

        broadcast({ type: "typing", typing: true, ...(routeTarget && { sessionId: routeTarget }) });
        if (!pailotSessionId) setLastRoutedSessionId(activeItermSessionId);

        const bridge = getAibpBridge();
        if (bridge && routeTarget) {
          bridge.routeFromMobile(routeTarget, text);
        } else {
          // Fallback to legacy routing
          setMessageSource("pailot");
          onMessage(text, Date.now());
          setMessageSource("whatsapp");
        }
      } catch {
        log(`[PAILot] Invalid message from ${addr}`);
      }
    });

    ws.on("close", () => {
      log(`PAILot client disconnected from ${addr}`);
      clients.delete(ws);
      clientLastActive.delete(ws);
      clientActiveSession.delete(ws);
    });

    ws.on("error", (err) => {
      log(`[PAILot] WebSocket error: ${err.message}`);
      clients.delete(ws);
      clientLastActive.delete(ws);
      clientActiveSession.delete(ws);
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
  // If an explicit sessionId was passed (from MCP detectSessionId), check the reply map
  // first — the reply map records which session the user was actually talking to,
  // which may differ from whatever iTerm tab is currently focused on the Mac.
  if (sessionId) {
    const mapped = pailotReplyMap.get(sessionId);
    if (mapped) return mapped;
    return sessionId;
  }
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
