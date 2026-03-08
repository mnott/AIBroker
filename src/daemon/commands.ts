/**
 * daemon/commands.ts — Unified slash-command router for the AIBroker hub.
 *
 * Handles all slash commands (/s, /ss, /c, /cc, /n, etc.) and message
 * delivery to iTerm2 sessions. Transport-agnostic — uses CommandContext
 * for all replies instead of calling adapter-specific send functions.
 *
 * This module was extracted from Whazaa's commands.ts to make it the
 * single command handler shared by all adapters.
 */

import { basename } from "node:path";

import {
  sessionRegistry,
  activeClientId,
  setActiveClientId,
  activeItermSessionId,
  setActiveItermSessionId,
  cachedSessionList,
  cachedSessionListTime,
  setCachedSessionList,
  clientQueues,
  managedSessions,
  dispatchIncomingMessage,
  sessionTtyCache,
  updateSessionTtyCache,
  messageSource,
} from "../core/state.js";
import {
  getSessionList,
  setItermSessionVar,
  setItermTabName,
  listClaudeSessions,
  createClaudeSession,
  createTerminalTab,
  getItermSessionVar,
  killSession,
  restartSession,
} from "../adapters/iterm/sessions.js";
import {
  runAppleScript,
  findClaudeSession,
  isClaudeRunningInSession,
  isScreenLocked,
  typeIntoSession,
  pasteTextIntoSession,
  sendKeystrokeToSession,
  sendEscapeSequenceToSession,
  stripItermPrefix,
  writeToTty,
  snapshotAllSessions,
} from "../adapters/iterm/core.js";
import { log } from "../core/log.js";
import { statusCache } from "../core/status-cache.js";
import { router } from "../core/router.js";
import { deliverViaApi } from "../core/transport.js";
import { hybridManager } from "../core/hybrid.js";
import type { CommandContext } from "./command-context.js";
import { handleScreenshot } from "./screenshot.js";

/**
 * Detect natural language image generation requests.
 * Returns the extracted prompt if matched, null otherwise.
 */
const IMAGE_REQUEST_PATTERNS = [
  /^(?:send|show|give|create|make|draw|paint|render|generate)\s+(?:me\s+)?(?:an?\s+)?(?:image|picture|photo|illustration|drawing|painting)\s+(?:of\s+)?(.+)/i,
  /^(?:schick|zeig|mach|erstell|generier|mal)\s+(?:mir\s+)?(?:ein(?:e|en)?\s+)?(?:bild|foto|zeichnung|illustration)\s+(?:von\s+)?(.+)/i,
];

function detectImageRequest(text: string): string | null {
  for (const pattern of IMAGE_REQUEST_PATTERNS) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

/**
 * Create the hub command handler.
 *
 * Returns a function that processes incoming messages (slash commands or
 * plain text) and routes them to iTerm2 sessions or API backends.
 *
 * The `ctx` parameter is provided per-message by the hub routing engine,
 * so the command handler knows how to reply to the originating adapter.
 */
export function createHubCommandHandler(): (
  text: string,
  timestamp: number,
  ctx: CommandContext,
) => void | Promise<void> {

  // ── Session resolution ──

  function ensureActiveSession(): string {
    const allSessions = getSessionList();
    const allSessionIds = new Set(allSessions.map((s) => s.id));

    for (const [sid, entry] of sessionRegistry) {
      if (entry.itermSessionId && !allSessionIds.has(entry.itermSessionId)) {
        sessionRegistry.delete(sid);
        clientQueues.delete(sid);
        if (activeClientId === sid) {
          const remaining = [...sessionRegistry.values()].sort((a, b) => b.registeredAt - a.registeredAt);
          setActiveClientId(remaining.length > 0 ? remaining[0].sessionId : null);
        }
      }
    }

    if (activeItermSessionId && !allSessionIds.has(activeItermSessionId)) {
      log(`ensureActiveSession: ${activeItermSessionId.slice(0, 8)}… not in live sessions — clearing`);
      setActiveItermSessionId("");
    }

    if (!activeItermSessionId && allSessions.length > 0) {
      const busy = allSessions.find((s) => s.type === "claude" && !s.atPrompt);
      const anyClaudeSession = allSessions.find((s) => s.type === "claude");
      const pick = busy ?? anyClaudeSession ?? allSessions[0];
      if (pick) {
        setActiveItermSessionId(pick.id);
        log(`ensureActiveSession: auto-selected ${pick.name} (${pick.id.slice(0, 8)}…)`);
      }
    }

    setCachedSessionList(allSessions, Date.now());
    return activeItermSessionId;
  }

  // ── Message delivery to iTerm2 ──

  function deliverMessage(text: string): boolean {
    const bareSessionId = stripItermPrefix(activeItermSessionId) ?? activeItermSessionId;
    if (bareSessionId && managedSessions.has(bareSessionId)) {
      if (typeIntoSession(bareSessionId, text)) return true;
      managedSessions.delete(bareSessionId);
    }

    if (activeItermSessionId) {
      if (typeIntoSession(activeItermSessionId, text)) return true;
    }

    if (isScreenLocked()) {
      const targetId = bareSessionId || activeItermSessionId;
      let ttyPath = targetId ? sessionTtyCache.get(targetId) : undefined;

      if (!ttyPath) {
        log("Screen locked — TTY cache miss, attempting live snapshot refresh");
        const fresh = snapshotAllSessions();
        updateSessionTtyCache(fresh);
        ttyPath = targetId ? sessionTtyCache.get(targetId) : undefined;
        if (!ttyPath && fresh.length > 0) {
          ttyPath = fresh[0].tty;
          log(`Screen locked — falling back to first available TTY: ${ttyPath}`);
        }
      }

      if (ttyPath) {
        log(`Screen locked — PTY write fallback to ${ttyPath}`);
        if (writeToTty(ttyPath, text)) return true;
        log(`PTY write fallback failed for ${ttyPath}`);
      } else {
        log("Screen locked — no TTY available for PTY fallback");
      }
      return false;
    }

    log(`${activeItermSessionId ? `Session ${activeItermSessionId} is not running Claude.` : "No cached session."} Searching for another...`);

    const found = findClaudeSession();
    if (found && isClaudeRunningInSession(found)) {
      setActiveItermSessionId(found);
      if (typeIntoSession(found, text)) return true;
    }

    log("No running Claude session found. Starting new one...");
    const created = createClaudeSession();
    if (created) {
      setActiveItermSessionId(created);
      if (typeIntoSession(created, text)) return true;
    }

    log("Failed to deliver message");
    return false;
  }

  // ── Terminal tab handling ──

  function handleTerminal(command: string | null): void {
    const newId = createTerminalTab(command ?? undefined);
    if (newId) {
      managedSessions.set(newId, { name: command ?? "terminal", createdAt: Date.now() });
      setActiveItermSessionId(newId);
      log(`/t: created terminal tab ${newId}`);
    }
  }

  // ── End session (close iTerm2 tab + cleanup) ──

  async function handleEndSessionVisual(session: { id: string; name: string; paiName: string | null }): Promise<void> {
    killSession(session.id);
    // Cleanup registry entries pointing to this iTerm session
    for (const [sid, entry] of sessionRegistry) {
      if (entry.itermSessionId === session.id) {
        sessionRegistry.delete(sid);
        clientQueues.delete(sid);
        if (activeClientId === sid) setActiveClientId(null);
      }
    }
    managedSessions.delete(session.id);
    if (activeItermSessionId === session.id) setActiveItermSessionId("");
    log(`Ended session ${session.id} ("${session.paiName ?? session.name}")`);
  }

  // ── Relocate (new visual session) ──

  function handleRelocate(targetPath: string): string | null {
    const command = `claude --dangerously-skip-permissions`;
    const newId = createClaudeSession(`cd ${targetPath} && ${command}`);
    return newId;
  }

  // ── Main command handler ──

  return function handleMessage(
    text: string,
    timestamp: number,
    ctx: CommandContext,
  ): void | Promise<void> {
    const trimmedText = text.trim();

    // --- /h, /help ---
    if (trimmedText === "/h" || trimmedText === "/help") {
      const help = [
        "*Commands*",
        "",
        "*Sessions*",
        "/s — List sessions",
        "/N — Switch to session N",
        "/N name — Switch & rename",
        "/n path — New visual session (iTerm2)",
        "/nh path — New headless session",
        "/t [cmd] — Open terminal tab",
        "/r N — Restart Claude in session N",
        "/e N — End session (close tab)",
        "",
        "*Session control*",
        "/c — Send /clear + go to Claude",
        "/p — Send \"pause session\" to Claude",
        "/ss — Screenshot",
        "/st — Session status (busy/idle)",
        "",
        "*Media*",
        "/image <prompt> — Generate an image",
        "",
        "*Watcher*",
        "/restart — Restart the adapter",
        "",
        "*Keys*",
        "/cc — Ctrl+C",
        "/esc — Escape",
        "/enter — Enter",
        "/tab — Tab",
        "/up /down /left /right — Arrows",
        "/pick N [text] — Menu select",
      ].join("\n");
      ctx.reply(help).catch(() => {});
      return;
    }

    // --- /nh <path> — new headless (API) session ---
    const nhMatch = trimmedText.match(/^\/nh\s+(.+)$/);
    if (nhMatch) {
      const targetPath = nhMatch[1].trim();
      if (targetPath && hybridManager) {
        const name = basename(targetPath);
        const session = hybridManager.createApiSession(name, targetPath);
        log(`/nh: created API session "${session.name}" (${session.id}) cwd=${session.cwd}`);
        ctx.reply(`New headless session: *${session.name}* (${session.cwd})`).catch(() => {});
      }
      return;
    }

    // --- /n <path> (aliases: /nv, /new, /relocate) — new visual session ---
    const relocateMatch = trimmedText.match(/^\/(?:n|nv|new|relocate)\s+(.+)$/);
    if (relocateMatch) {
      const targetPath = relocateMatch[1].trim();
      if (targetPath) {
        const newSessionId = handleRelocate(targetPath);
        if (newSessionId) {
          const name = basename(targetPath);
          if (hybridManager) {
            hybridManager.registerVisualSession(name, targetPath, newSessionId);
          }
          setActiveItermSessionId(newSessionId);
          log(`/n: created visual session "${name}" (iTerm2=${newSessionId})`);
          ctx.reply(`New visual session: *${name}* (${targetPath})`).catch(() => {});
        }
        return;
      }
      log("/n: no path provided");
      return;
    }

    // --- /sessions (aliases: /s) — list sessions ---
    if (trimmedText === "/sessions" || trimmedText === "/s") {
      if (hybridManager) {
        // Prune dead visual sessions before listing
        const liveSnapshots = snapshotAllSessions();
        const liveIds = new Set(liveSnapshots.map(s => s.id));
        hybridManager.pruneDeadVisualSessions(liveIds);
        const list = hybridManager.formatSessionList();
        ctx.reply(list).catch(() => {});
        return;
      }

      ensureActiveSession();
      const allSessions = cachedSessionList ?? getSessionList();
      if (allSessions.length === 0 && sessionRegistry.size === 0) {
        ctx.reply("No sessions found.").catch(() => {});
        return;
      }

      const lines = allSessions.map((s, i) => {
        const regEntry = [...sessionRegistry.values()].find((e) => e.itermSessionId === s.id);
        const label = s.paiName
          ?? (regEntry ? regEntry.name : null)
          ?? (s.path ? basename(s.path) : null)
          ?? s.name;
        const typeTag = s.type === "terminal" ? " [terminal]" : "";
        const isActive = activeItermSessionId
          ? s.id === activeItermSessionId
          : regEntry ? activeClientId === regEntry.sessionId : false;
        return `${i + 1}. ${label}${typeTag}${isActive ? " \u2190 active" : ""}`;
      });
      ctx.reply(lines.join("\n")).catch(() => {});
      return;
    }

    // --- /N [name] — switch to session N, optionally rename ---
    const sessionSwitchMatch = trimmedText.match(/^\/(\d+)\s*(.*)?$/);
    if (sessionSwitchMatch) {
      const num = parseInt(sessionSwitchMatch[1], 10);
      const newName = sessionSwitchMatch[2]?.trim() || null;

      if (hybridManager) {
        const session = hybridManager.switchToIndex(num);
        if (!session) {
          const count = hybridManager.listSessions().length;
          ctx.reply(`Invalid session number. Use /s to list (1-${count}).`).catch(() => {});
          return;
        }
        if (session.kind === "visual") {
          setActiveItermSessionId(session.backendSessionId);
        }
        log(`/N: switched to ${session.kind} session "${session.name}" (${session.id})`);
        const tag = session.kind === "api" ? " [api]" : " [visual]";
        ctx.reply(`Switched to *${session.name}*${tag}`).catch(() => {});
        return;
      }

      // Legacy fallback
      const CACHE_TTL_MS = 60_000;
      const sessions =
        cachedSessionList && (Date.now() - cachedSessionListTime < CACHE_TTL_MS)
          ? cachedSessionList
          : getSessionList();
      if (sessions.length === 0) {
        ctx.reply("No sessions found.").catch(() => {});
        return;
      }
      if (num < 1 || num > sessions.length) {
        ctx.reply(`Invalid session number. Use /s to list (1-${sessions.length}).`).catch(() => {});
        return;
      }
      const chosen = sessions[num - 1];
      const escapedSessionId = chosen.id.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const focusScript = `
tell application "iTerm2"
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      repeat with aSession in sessions of aTab
        if id of aSession is "${escapedSessionId}" then
          select aSession
          return "focused"
        end if
      end repeat
    end repeat
  end repeat
  return "not_found"
end tell`;
      const focusResult = runAppleScript(focusScript);
      if (focusResult === "focused") {
        setActiveItermSessionId(chosen.id);
        const regEntry = [...sessionRegistry.values()].find((e) => e.itermSessionId === chosen.id);
        if (regEntry) {
          setActiveClientId(regEntry.sessionId);
        } else {
          setActiveClientId(null);
        }

        if (newName) {
          setItermSessionVar(chosen.id, newName);
          setItermTabName(chosen.id, newName);
          if (regEntry) regEntry.name = newName;
        }

        const displayName = newName
          ?? chosen.paiName
          ?? (regEntry ? regEntry.name : null)
          ?? (chosen.path ? basename(chosen.path) : chosen.name);
        ctx.reply(`Switched to *${displayName}*`).catch(() => {});
      } else {
        ctx.reply("Session not found — it may have closed.").catch(() => {});
      }
      return;
    }

    // --- /t [command] — open a raw terminal tab ---
    if (trimmedText === "/t" || trimmedText === "/terminal") {
      handleTerminal(null);
      return;
    }
    const terminalMatch = trimmedText.match(/^\/(?:t|terminal)\s+(.+)$/);
    if (terminalMatch) {
      handleTerminal(terminalMatch[1].trim());
      return;
    }

    // --- /restart — restart the adapter (adapter handles this locally) ---
    // This is forwarded back to the originating adapter for local restart.
    // The hub cannot restart adapters directly.
    if (trimmedText === "/restart") {
      log("/restart: forwarded to adapter");
      ctx.reply("Restart command — handled by adapter.").catch(() => {});
      return;
    }

    // --- /image, /img <prompt> — generate an image ---
    const imageMatch = trimmedText.match(/^\/(?:image|img)\s+(.+)$/s);
    if (imageMatch) {
      const prompt = imageMatch[1].trim();
      ctx.reply("On it... generating your image.").catch(() => {});
      (async () => {
        try {
          const { generateImage } = await import("./image-gen.js");
          const result = await generateImage({ prompt });
          if (result.images.length > 0) {
            await ctx.replyImage(result.images[0], prompt.slice(0, 200));
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          ctx.reply(`Image generation failed: ${errMsg}`).catch(() => {});
          log(`/image: error — ${errMsg}`);
        }
      })().catch((err) => log(`/image: unhandled error — ${err}`));
      return;
    }

    // --- /ss, /screenshot ---
    if (trimmedText === "/ss" || trimmedText === "/screenshot") {
      if (hybridManager) {
        const status = hybridManager.formatActiveStatus();
        if (status !== null) {
          ctx.reply(status).catch(() => {});
        } else {
          handleScreenshot(ctx).catch((err) => log(`/ss: unhandled error — ${err}`));
        }
        return;
      }
      handleScreenshot(ctx).catch((err) => log(`/ss: unhandled error — ${err}`));
      return;
    }

    // --- /c — clear active session context ---
    if (trimmedText === "/c") {
      if (hybridManager) {
        const active = hybridManager.activeSession;
        if (active?.kind === "api") {
          hybridManager.clearActiveSession();
          log("/c: cleared API session conversation history");
          ctx.reply("Session cleared.").catch(() => {});
          return;
        }
      }

      ensureActiveSession();
      if (!activeItermSessionId) {
        ctx.reply("No active session.").catch(() => {});
        return;
      }
      ctx.reply("Clearing in ~10s…").catch(() => {});
      (async () => {
        const sid = activeItermSessionId;
        await new Promise((r) => setTimeout(r, 10000));
        typeIntoSession(sid, "/clear");
        await new Promise((r) => setTimeout(r, 8000));
        pasteTextIntoSession(sid, "go");
        await new Promise((r) => setTimeout(r, 500));
        sendKeystrokeToSession(sid, 13);
        ctx.reply("Sent /clear + go").catch(() => {});
      })().catch((err) => log(`/c: error — ${err}`));
      return;
    }

    // --- /p — send "pause session" to active Claude session ---
    if (trimmedText === "/p") {
      ensureActiveSession();
      if (!activeItermSessionId) {
        ctx.reply("No active session.").catch(() => {});
        return;
      }
      typeIntoSession(activeItermSessionId, "pause session");
      ctx.reply("Sent \"pause session\"").catch(() => {});
      return;
    }

    // --- Keyboard control commands ---
    if (
      trimmedText === "/cc" ||
      trimmedText === "/esc" ||
      trimmedText === "/enter" ||
      trimmedText === "/tab" ||
      trimmedText === "/up" ||
      trimmedText === "/down" ||
      trimmedText === "/left" ||
      trimmedText === "/right" ||
      /^\/pick\s+(\d+)/.test(trimmedText)
    ) {
      if (hybridManager?.activeSession?.kind === "api") {
        ctx.reply("Keyboard commands need a visual session. Use /nv to create one.").catch(() => {});
        return;
      }
      ensureActiveSession();
      if (!activeItermSessionId) {
        ctx.reply("No active session.").catch(() => {});
        return;
      }

      if (trimmedText === "/cc") {
        sendKeystrokeToSession(activeItermSessionId, 3);
        ctx.reply("Ctrl+C sent").catch(() => {});
        return;
      }
      if (trimmedText === "/esc") {
        sendKeystrokeToSession(activeItermSessionId, 27);
        ctx.reply("Esc sent").catch(() => {});
        return;
      }
      if (trimmedText === "/enter") {
        sendKeystrokeToSession(activeItermSessionId, 13);
        ctx.reply("Enter sent").catch(() => {});
        return;
      }
      if (trimmedText === "/tab") {
        sendKeystrokeToSession(activeItermSessionId, 9);
        ctx.reply("Tab sent").catch(() => {});
        return;
      }
      if (trimmedText === "/up") {
        sendEscapeSequenceToSession(activeItermSessionId, "A");
        ctx.reply("\u2191").catch(() => {});
        return;
      }
      if (trimmedText === "/down") {
        sendEscapeSequenceToSession(activeItermSessionId, "B");
        ctx.reply("\u2193").catch(() => {});
        return;
      }
      if (trimmedText === "/left") {
        sendEscapeSequenceToSession(activeItermSessionId, "D");
        ctx.reply("\u2190").catch(() => {});
        return;
      }
      if (trimmedText === "/right") {
        sendEscapeSequenceToSession(activeItermSessionId, "C");
        ctx.reply("\u2192").catch(() => {});
        return;
      }

      const pickMatch = trimmedText.match(/^\/pick\s+(\d+)(?:\s+(.+))?$/);
      if (pickMatch) {
        const pickNum = parseInt(pickMatch[1], 10);
        const pickText = pickMatch[2] || null;
        if (pickNum < 1) {
          ctx.reply("Pick number must be at least 1.").catch(() => {});
          return;
        }
        const sessionId = activeItermSessionId;
        (async () => {
          for (let i = 0; i < pickNum - 1; i++) {
            sendEscapeSequenceToSession(sessionId, "B");
            await new Promise((r) => setTimeout(r, 50));
          }
          sendKeystrokeToSession(sessionId, 13);
          if (pickText) {
            await new Promise((r) => setTimeout(r, 200));
            typeIntoSession(sessionId, pickText);
          }
          const msgText = pickText ? `Picked option ${pickNum}: ${pickText}` : `Picked option ${pickNum}`;
          ctx.reply(msgText).catch(() => {});
        })().catch((err) => log(`/pick: error — ${err}`));
        return;
      }
    }

    // --- /r N — restart Claude in session N ---
    const restartMatch = trimmedText.match(/^\/(?:restart|r)\s+(\d+)$/);
    if (restartMatch) {
      const num = parseInt(restartMatch[1], 10);
      const sessions = getSessionList();
      if (sessions.length === 0) {
        ctx.reply("No sessions found.").catch(() => {});
        return;
      }
      if (num < 1 || num > sessions.length) {
        ctx.reply(`Invalid session number. Use /s to list (1-${sessions.length}).`).catch(() => {});
        return;
      }
      const target = sessions[num - 1];
      if (target.type === "terminal") {
        ctx.reply("Use /e to end terminal sessions.").catch(() => {});
      } else {
        restartSession(target.id).catch((err) => log(`/r: error — ${err}`));
        ctx.reply(`Restarting session ${num}…`).catch(() => {});
      }
      return;
    }

    // --- /e N — end session (close tab + remove from registry) ---
    const endMatch = trimmedText.match(/^\/(?:end|e)\s+(\d+)$/);
    if (endMatch) {
      const num = parseInt(endMatch[1], 10);

      if (hybridManager) {
        const session = hybridManager.getByIndex(num);
        if (!session) {
          const count = hybridManager.listSessions().length;
          ctx.reply(`Invalid session number. Use /s to list (1-${count}).`).catch(() => {});
          return;
        }
        if (session.kind === "visual") {
          const itermSessions = getSessionList();
          const target = itermSessions.find(s => s.id === session.backendSessionId);
          if (target) {
            handleEndSessionVisual(target).catch((err) => log(`/e: error — ${err}`));
          }
        }
        hybridManager.removeByIndex(num);
        log(`/e: ended ${session.kind} session "${session.name}" (${session.id})`);
        ctx.reply(`Ended session *${session.name}*.`).catch(() => {});
        return;
      }

      const sessions = getSessionList();
      if (sessions.length === 0) {
        ctx.reply("No sessions found.").catch(() => {});
        return;
      }
      if (num < 1 || num > sessions.length) {
        ctx.reply(`Invalid session number. Use /s to list (1-${sessions.length}).`).catch(() => {});
        return;
      }
      const target = sessions[num - 1];
      handleEndSessionVisual(target).catch((err) => log(`/e: error — ${err}`));
      ctx.reply(`Ended session *${target.paiName ?? target.name}*.`).catch(() => {});
      return;
    }

    // --- /status, /st — show status of all Claude sessions ---
    if (trimmedText === "/status" || trimmedText === "/st") {
      const snapshots = snapshotAllSessions();
      if (snapshots.length === 0) {
        ctx.reply("No iTerm2 sessions found.").catch(() => {});
        return;
      }

      const lines: string[] = ["*Session Status*", ""];
      for (let i = 0; i < snapshots.length; i++) {
        const snap = snapshots[i];
        const label = snap.paiName ?? snap.tabTitle ?? snap.name;
        const isActive = snap.id === activeItermSessionId;

        // Determine status from atPrompt + cached state
        let statusIcon: string;
        let statusLabel: string;
        const cached = statusCache.get(snap.id);
        if (cached && cached.state !== "idle" && !snap.atPrompt) {
          // Cache has a non-idle state and iTerm confirms not at prompt
          statusIcon = "🔴";
          statusLabel = "busy";
        } else if (snap.atPrompt) {
          statusIcon = "🟢";
          statusLabel = "idle";
        } else {
          statusIcon = "🟡";
          statusLabel = "working";
        }

        const activeTag = isActive ? " ← active" : "";
        lines.push(`${i + 1}. ${statusIcon} *${label}* — ${statusLabel}${activeTag}`);

        // Include cached summary if available and recent (< 5 min)
        if (cached?.summary && Date.now() - cached.timestamp < 5 * 60 * 1000) {
          lines.push(`   _${cached.summary}_`);
        }
      }

      ctx.reply(lines.join("\n")).catch(() => {});
      return;
    }

    // --- Natural language image generation detection ---
    const imageNlMatch = detectImageRequest(trimmedText);
    if (imageNlMatch) {
      ctx.reply("On it... generating your image.").catch(() => {});
      (async () => {
        try {
          const { generateImage } = await import("./image-gen.js");
          const result = await generateImage({ prompt: imageNlMatch });
          if (result.images.length > 0) {
            await ctx.replyImage(result.images[0], imageNlMatch.slice(0, 200));
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          ctx.reply(`Image generation failed: ${errMsg}`).catch(() => {});
          log(`image-gen: error — ${errMsg}`);
        }
      })().catch((err) => log(`image-gen: unhandled error — ${err}`));
      return;
    }

    // --- Plain text / unrecognized commands → dispatch to iTerm2 ---

    dispatchIncomingMessage(text, timestamp);

    // Prefix with adapter source tag so Claude knows where to reply
    const tag = ctx.source === "pailot"
      ? "PAILot"
      : ctx.source === "telex"
        ? "Telex"
        : "Whazaa";

    let textToDeliver: string;
    if (trimmedText.startsWith("!")) {
      textToDeliver = text.replace(/^!/, "");
    } else if (trimmedText.startsWith("/")) {
      textToDeliver = text;
    } else if (/^\[(?:Voice note|Audio)\]:/.test(trimmedText)) {
      textToDeliver = `[${tag}:voice] ${text}`;
    } else {
      textToDeliver = `[${tag}] ${text}`;
    }

    // Route based on active session kind
    const activeHybrid = hybridManager?.activeSession;
    if (activeHybrid?.kind === "api") {
      deliverViaApi(hybridManager!.apiBackend, textToDeliver, activeHybrid.backendSessionId, {
        sendText: (replyText) => ctx.reply(replyText),
        sendVoice: (buffer, transcript) => ctx.replyVoice(buffer, transcript ?? ""),
      });
      return;
    }

    // Visual session — deliver to iTerm2
    deliverMessage(textToDeliver);
  };
}
