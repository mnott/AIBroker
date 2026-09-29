/**
 * daemon/screenshot.ts — Screenshot capture for the AIBroker hub.
 *
 * Captures the iTerm2 window containing the active session and sends
 * it back through the CommandContext reply channel. Handles screen-lock
 * detection with text fallback.
 *
 * Extracted from Whazaa's screenshot.ts — now transport-agnostic.
 */

import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, execSync } from "node:child_process";

import {
  runItermJxa,
  stripItermPrefix,
  snapshotAllSessions,
  withSessionJxa,
} from "../adapters/iterm/core.js";
import { listClaudeSessions } from "../adapters/iterm/sessions.js";
import { snapshotAllSessions as snapshotAllTransportSessions, routeToTmux, captureSession } from "../transport/sync-facade.js";
import { itermInPlay } from "../transport/policy.js";
import { log } from "../core/log.js";
import {
  activeClientId,
  activeItermSessionId,
  setActiveItermSessionId,
  sessionRegistry,
} from "../core/state.js";
import { broadcastImage, broadcastText } from "../adapters/pailot/gateway.js";
import type { CommandContext } from "./command-context.js";

let lastScreenshotContent: string | null = null;

function getActiveSessionContent(): string | null {
  const activeEntry = activeClientId ? sessionRegistry.get(activeClientId) : undefined;
  const itermId = stripItermPrefix(
    (activeItermSessionId || undefined) ?? activeEntry?.itermSessionId
  );
  if (!itermId) return null;

  const stdout = runItermJxa(withSessionJxa(itermId, "          return aSession.contents();"), 10_000) ?? "";
  return stdout || null;
}

/**
 * The tmux pane this command targets, or null when it targets an iTerm tab
 * (or nothing). Where iTerm is not in play at all, an unaddressed /ss falls
 * back to the first live pane — there is no other kind of session to pick.
 */
function tmuxTargetFor(ctx: CommandContext): string | null {
  const activeEntry = activeClientId ? sessionRegistry.get(activeClientId) : undefined;
  const id = stripItermPrefix(ctx.sessionId ?? (activeItermSessionId || undefined) ?? activeEntry?.itermSessionId);
  if (id) return routeToTmux(id) ? id : null;
  return itermInPlay() ? null : snapshotAllTransportSessions()[0]?.id ?? null;
}

/** /ss on tmux: there is no window to photograph, so reply with the pane's text. */
async function handleTmuxScreenshot(ctx: CommandContext, paneId: string): Promise<void> {
  const raw = captureSession(paneId, 60);
  if (raw === null) {
    await ctx.reply("Could not read the tmux pane — it may have closed.");
    return;
  }
  const text = raw
    .split("\n")
    .filter((l) => !/^[─━═┄┈╌╍┅┉]{3,}\s*$/.test(l.trim()))
    .filter((l) => l.trim() !== "")
    .slice(-50)
    .join("\n");
  if (!text) {
    await ctx.reply("The tmux pane is empty.");
    return;
  }
  if (ctx.source !== "pailot") broadcastText(`Terminal capture:\n\n${text}`);
  const maxLen = 4000;
  const trimmed = text.length > maxLen ? "...\n" + text.slice(-maxLen) : text;
  await ctx.reply(`*Terminal capture (tmux):*\n\n\`\`\`\n${trimmed}\n\`\`\``);
  log("/ss: tmux pane text sent");
}

async function handleTextScreenshot(ctx: CommandContext): Promise<void> {
  try {
    const candidates: Array<{ id: string; source: string }> = [];
    const activeEntry = activeClientId ? sessionRegistry.get(activeClientId) : undefined;
    const primaryId = stripItermPrefix(
      (activeItermSessionId || undefined) ?? activeEntry?.itermSessionId
    );
    if (primaryId) candidates.push({ id: primaryId, source: "active" });

    const registryEntries = [...sessionRegistry.values()]
      .sort((a, b) => b.registeredAt - a.registeredAt);
    for (const entry of registryEntries) {
      const rid = stripItermPrefix(entry.itermSessionId);
      if (rid && !candidates.some((c) => c.id === rid)) {
        candidates.push({ id: rid, source: `registry:${entry.name}` });
      }
    }

    if (candidates.length === 0) {
      await ctx.reply("Screen is locked and no iTerm2 session found — cannot capture.");
      return;
    }

    for (const candidate of candidates) {
      const stdout = runItermJxa(withSessionJxa(candidate.id, "          return aSession.contents();", '"::NOT_FOUND::"'), 10_000) ?? "";
      if (stdout === "::NOT_FOUND::" || stdout === "") continue;

      lastScreenshotContent = stdout;

      // Send to PAILot (skip if the request came from PAILot — ctx.reply handles it)
      if (ctx.source !== "pailot") {
        const cleaned = stdout
          .split("\n")
          .filter((line: string) => !/^[─━═┄┈╌╍┅┉]{3,}\s*$/.test(line.trim()))
          .filter((line: string) => line.trim() !== "")
          .slice(-50)
          .join("\n");
        broadcastText(`Terminal capture (screen locked):\n\n${cleaned}`);
      }

      // Send to originating adapter
      const maxLen = 4000;
      const trimmed = stdout.length > maxLen ? "...\n" + stdout.slice(-maxLen) : stdout;
      await ctx.reply(`*Terminal capture (screen locked):*\n\n\`\`\`\n${trimmed}\n\`\`\``);
      return;
    }

    await ctx.reply(`Screen is locked — tried ${candidates.length} session(s) but none returned buffer content.`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`/ss: text capture error — ${msg}`);
    await ctx.reply(`Screen is locked — text capture failed: ${msg}`);
  }
}

/**
 * Find the iTerm2 window containing a session and select its tab.
 *
 * `screencapture -l` captures whatever tab is currently visible in the
 * window, so the tab holding the target session has to be brought to the
 * front first — this is that step, shared by the ctx-driven screenshot and
 * the headless capture below. Returns "" if the session cannot be found.
 */
function resolveWindowIdForSession(sessionId: string): string {
  const result = runItermJxa(withSessionJxa(
    sessionId,
    `          aTab.select();\n          return String(aWindow.id());`,
  ));
  return result?.trim() ?? "";
}

/**
 * Capture a window to a PNG buffer via `screencapture`.
 *
 * Throws on failure (screen lock, bad window id, etc.) — callers that want a
 * text fallback catch it themselves; `captureSessionPng` below catches it to
 * return null instead, since a headless caller has no text fallback to run.
 */
function capturePngForWindow(windowId: string): Buffer {
  const filePath = join(tmpdir(), `aibroker-screenshot-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
  try {
    execSync(`/usr/sbin/screencapture -x -l ${windowId} "${filePath}"`, { timeout: 15_000 });
    return readFileSync(filePath);
  } finally {
    try { unlinkSync(filePath); } catch { /* ignore */ }
  }
}

/**
 * Headless screenshot capture — no CommandContext, no reply channel.
 *
 * For a caller (the daemon manager alerting the operator about a stuck
 * session) that has a bare iTerm2 sessionId and wants PNG bytes back
 * directly, with no session-lookup fallbacks and no text-mode fallback:
 * either this session's window is found and captured, or null comes back
 * and the caller decides what to do (e.g. fall back to a text alert).
 */
export async function captureSessionPng(sessionId: string): Promise<{ buffer: Buffer; mime: string } | null> {
  if (routeToTmux(sessionId)) return null; // no window to photograph; the caller falls back to text
  try {
    const windowId = resolveWindowIdForSession(sessionId);
    if (!windowId) return null;
    // Brief delay for the just-selected tab to render before capture.
    spawnSync("sleep", ["0.3"]);
    const buffer = capturePngForWindow(windowId);
    return { buffer, mime: "image/png" };
  } catch (err) {
    log(`captureSessionPng: failed — ${(err as Error).message}`);
    return null;
  }
}

let _screenshotInFlight = false;

export async function handleScreenshot(ctx: CommandContext): Promise<void> {
  // Debounce: if a screenshot is already in progress, skip
  if (_screenshotInFlight) {
    log("/ss: already in progress, skipping");
    return;
  }
  _screenshotInFlight = true;
  try {
    await _handleScreenshotImpl(ctx);
  } finally {
    _screenshotInFlight = false;
  }
}

async function _handleScreenshotImpl(ctx: CommandContext): Promise<void> {
  const tmuxPane = tmuxTargetFor(ctx);
  if (tmuxPane) return handleTmuxScreenshot(ctx, tmuxPane);

  // Content-unchanged optimization: skip text fallback for non-PAILot sources
  // PAILot always gets a real screenshot (window capture is fast)
  const currentContent = getActiveSessionContent();
  if (ctx.source !== "pailot" && currentContent && lastScreenshotContent) {
    const tail = (s: string) => s.split("\n").slice(-100).join("\n").trim();
    if (tail(currentContent) === tail(lastScreenshotContent)) {
      const lines = currentContent
        .split("\n")
        .filter((l: string) => !/^[─━═┄┈╌╍┅┉]{3,}\s*$/.test(l.trim()))
        .filter((l: string) => l.trim() !== "")
        .slice(-30)
        .join("\n");
      if (lines) {
        broadcastText(lines);
        await ctx.reply(`*Terminal (unchanged):*\n\n\`\`\`\n${lines}\n\`\`\``);
        log("/ss: content unchanged, sent tail as text");
        return;
      }
    }
  }
  lastScreenshotContent = currentContent;

  // Check screen lock
  try {
    const lockCheck = spawnSync(
      "sh",
      ["-c", "ioreg -n Root -d1 -a | grep -c CGSSessionScreenIsLocked"],
      { timeout: 5_000, encoding: "utf8" }
    );
    if (parseInt((lockCheck.stdout ?? "0").trim(), 10) > 0) {
      log("/ss: screen is locked — falling back to terminal text capture");
      await handleTextScreenshot(ctx);
      return;
    }
  } catch { /* proceed */ }

  await ctx.reply("Capturing screenshot...");

  try {
    // Resolve the window
    let windowId: string = "";
    const activeEntry = activeClientId ? sessionRegistry.get(activeClientId) : undefined;
    // Prefer the session from the command context (PAILot's active session)
    // over the global activeItermSessionId (which may be a different tab)
    let itermSessionId = stripItermPrefix(
      ctx.sessionId ?? (activeItermSessionId || undefined) ?? activeEntry?.itermSessionId
    );

    if (!itermSessionId) {
      const registryEntries = [...sessionRegistry.values()]
        .sort((a, b) => b.registeredAt - a.registeredAt);
      const newest = registryEntries.find(e => e.itermSessionId);
      if (newest?.itermSessionId) {
        itermSessionId = stripItermPrefix(newest.itermSessionId);
        setActiveItermSessionId(itermSessionId!);
      }
    }

    if (!itermSessionId) {
      const liveSessions = listClaudeSessions();
      if (liveSessions.length > 0) {
        itermSessionId = liveSessions[0].id;
        setActiveItermSessionId(liveSessions[0].id);
      }
    }

    // Find the window and SELECT the tab containing the target session
    // screencapture -l captures the visible tab, so we must switch to it
    if (itermSessionId) {
      windowId = resolveWindowIdForSession(itermSessionId);
      // Brief delay for tab to render
      if (windowId) {
        spawnSync("sleep", ["0.3"]);
      }
    }

    if (!windowId) {
      // Fallback: use frontmost window
      const fb = runItermJxa("return String(app.windows()[0].id());") ?? "";
      windowId = fb.trim();
    }

    if (!windowId) {
      await ctx.reply("Error: Could not get iTerm2 window ID.");
      return;
    }

    log(`/ss: capturing window ${windowId}`);
    const buffer = capturePngForWindow(windowId);

    // Send to PAILot WebSocket clients (skip if request came from PAILot)
    if (ctx.source !== "pailot") broadcastImage(buffer, "Screenshot");

    // Send to originating adapter
    await ctx.replyImage(buffer, "Screenshot");

    log("/ss: screenshot sent");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`/ss: screencapture failed — ${msg}`);

    // If screencapture failed (e.g. screen locked but ioreg didn't detect it,
    // or "could not create image from rect"), fall back to text mode
    log("/ss: falling back to terminal text capture");
    await handleTextScreenshot(ctx);
    return;
  }
}
