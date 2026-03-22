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
  runAppleScript,
  stripItermPrefix,
  snapshotAllSessions,
} from "../adapters/iterm/core.js";
import { listClaudeSessions } from "../adapters/iterm/sessions.js";
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

  const result = spawnSync("osascript", [], {
    input: `tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if id of s is "${itermId}" then
          return contents of s
        end if
      end repeat
    end repeat
  end repeat
  return ""
end tell`,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 10_000,
  });

  if (result.status !== 0 || result.signal) return null;
  const stdout = result.stdout?.toString().trim() ?? "";
  return stdout || null;
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
      const script = `tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if id of s is "${candidate.id}" then
          return contents of s
        end if
      end repeat
    end repeat
  end repeat
  return "::NOT_FOUND::"
end tell`;

      const result = spawnSync("osascript", [], {
        input: script,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 10_000,
      });

      const stdout = result.stdout?.toString().trim() ?? "";
      if (result.signal === "SIGTERM" || result.status !== 0 || stdout === "::NOT_FOUND::" || stdout === "") continue;

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

export async function handleScreenshot(ctx: CommandContext): Promise<void> {
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

  const filePath = join(tmpdir(), `aibroker-screenshot-${Date.now()}.png`);

  try {
    // Resolve the window
    let windowId: string;
    const activeEntry = activeClientId ? sessionRegistry.get(activeClientId) : undefined;
    let itermSessionId = stripItermPrefix((activeItermSessionId || undefined) ?? activeEntry?.itermSessionId);

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

    if (itermSessionId) {
      const findAndRaiseScript = `tell application "iTerm2"
  repeat with w in windows
    set tabCount to count of tabs of w
    repeat with tabIdx from 1 to tabCount
      set t to tab tabIdx of w
      repeat with s in sessions of t
        if id of s is "${itermSessionId}" then
          select t
          set index of w to 1
          activate
          return (id of w as text)
        end if
      end repeat
    end repeat
  end repeat
  return ""
end tell`;
      const findResult = runAppleScript(findAndRaiseScript);
      if (findResult && findResult !== "") {
        windowId = findResult.trim();
      } else {
        runAppleScript('tell application "iTerm2" to activate');
        const fb = runAppleScript(`tell application "iTerm2"\n  set w to window 1\n  activate\n  return (id of w as text)\nend tell`) ?? "";
        windowId = fb.trim();
      }
    } else {
      runAppleScript('tell application "iTerm2" to activate');
      const fb = runAppleScript(`tell application "iTerm2"\n  set w to window 1\n  activate\n  return (id of w as text)\nend tell`) ?? "";
      windowId = fb.trim();
    }

    if (!windowId) {
      await ctx.reply("Error: Could not get iTerm2 window ID.");
      return;
    }

    await new Promise((r) => setTimeout(r, 1500));

    // Use window ID capture (-l) instead of region (-R) — region fails on
    // multi-display setups where the window coordinates exceed a single screen.
    log(`/ss: capturing window ${windowId}`);
    execSync(`/usr/sbin/screencapture -x -l ${windowId} "${filePath}"`, { timeout: 15_000 });

    const buffer = readFileSync(filePath);

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
    try { unlinkSync(filePath); } catch { /* ignore */ }
    await handleTextScreenshot(ctx);
    return;
  } finally {
    try { unlinkSync(filePath); } catch { /* ignore */ }
  }
}
