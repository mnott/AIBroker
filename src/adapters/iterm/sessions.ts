/**
 * adapters/iterm/sessions.ts — Higher-level iTerm2 session management.
 *
 * Session variables, tab naming, discovery, creation, and lifecycle.
 * Does NOT import any transport send functions — callers handle message delivery.
 */

import { execSync } from "node:child_process";
import { basename } from "node:path";

import {
  runAppleScript,
  isItermRunning,
  isClaudeRunningInSession,
  isItermSessionAlive,
  typeIntoSession,
  sendKeystrokeToSession,
  stripItermPrefix,
  withSessionAppleScript,
  snapshotAllSessions,
} from "./core.js";
import { log } from "../../core/log.js";
import {
  sessionRegistry,
  managedSessions,
  activeItermSessionId,
  setActiveItermSessionId,
  clientQueues,
  updateSessionTtyCache,
} from "../../core/state.js";
import { saveSessionRegistry } from "../../core/persistence.js";

// ── Session Variable Helpers ──

function setItermSessionProperty(itermSessionId: string, body: string): void {
  try {
    const script = withSessionAppleScript(
      itermSessionId,
      `          tell aSession\n            ${body}\n          end tell\n          return`,
      ""
    );
    execSync(`osascript <<'APPLESCRIPT'\n${script}\nAPPLESCRIPT`, {
      timeout: 5000,
      shell: "/bin/bash",
    });
  } catch {
    // silently ignore
  }
}

export function setItermSessionVar(itermSessionId: string, name: string): void {
  const escaped = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\n\r]/g, " ");
  setItermSessionProperty(itermSessionId, `set variable named "user.paiName" to "${escaped}"`);
}

export function setItermTabName(itermSessionId: string, name: string): void {
  // Fire-and-forget: rename the tab via iTerm2's native WebSocket API.
  // This sets the persistent title override (same as double-click rename).
  import("./iterm2-api.js").then(({ iterm2SetTabTitle }) =>
    iterm2SetTabTitle(itermSessionId, name).catch((err) =>
      log(`Tab rename failed: ${err instanceof Error ? err.message : String(err)}`),
    ),
  );
}

export function setItermBadge(itermSessionId: string, text: string): void {
  // Write badge escape sequence to the session's tty device.
  // Must go to terminal output stream (not stdin via "write text").
  try {
    const tty = execSync(
      `osascript -e 'tell application "iTerm2" to repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            if (unique ID of s) is "${itermSessionId}" then return tty of s
          end repeat
        end repeat
      end repeat'`,
      { timeout: 5000, encoding: "utf8", shell: "/bin/bash" },
    ).trim();
    if (!tty || !tty.startsWith("/dev/ttys")) return;
    const b64 = Buffer.from(text).toString("base64");
    execSync(`printf '\\033]1337;SetBadgeFormat=${b64}\\007' > ${tty}`, {
      timeout: 3000,
      shell: "/bin/bash",
    });
  } catch {
    // silently ignore — badge is cosmetic
  }
}

export function getItermSessionVar(itermSessionId: string): string | null {
  try {
    const script = withSessionAppleScript(
      itermSessionId,
      `          tell aSession\n            try\n              return (variable named "user.paiName")\n            on error\n              return ""\n            end try\n          end tell`,
      'return ""'
    );
    const result = execSync(`osascript <<'APPLESCRIPT'\n${script}\nAPPLESCRIPT`, {
      timeout: 5000,
      encoding: "utf8",
      shell: "/bin/bash",
    }).trim();
    return (result && result !== "missing value") ? result : null;
  } catch {
    return null;
  }
}

// ── Session Resolution ──

export function findItermSessionForTermId(
  termSessionId: string,
  itermSessionIdHint?: string,
): string | null {
  if (itermSessionIdHint) {
    return stripItermPrefix(itermSessionIdHint) ?? itermSessionIdHint;
  }

  const script = `
tell application "iTerm2"
  set output to ""
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      repeat with aSession in sessions of aTab
        set envVal to ""
        try
          tell aSession to set envVal to (variable named "TERM_SESSION_ID")
        end try
        if envVal is "${termSessionId.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}" then
          return id of aSession
        end if
      end repeat
    end repeat
  end repeat
  return ""
end tell`;

  const result = runAppleScript(script);
  return (result && result.length > 0) ? result : null;
}

// ── Session Listing ──

export function listClaudeSessions(): Array<{ id: string; name: string }> {
  const sessions = snapshotAllSessions();
  return sessions
    .filter((s) => s.name.toLowerCase().includes("claude") || s.paiName)
    .map((s) => ({ id: s.id, name: s.paiName ?? s.name }));
}

/**
 * Build a full session list with type classification and PAI name resolution.
 * Returns the data used by /s command.
 */
export function getSessionList(): Array<{
  id: string;
  name: string;
  path: string;
  type: "claude" | "terminal";
  paiName: string | null;
  atPrompt: boolean;
}> {
  const snapshots = snapshotAllSessions();

  // Update TTY cache
  updateSessionTtyCache(snapshots.map((s) => ({ id: s.id, tty: s.tty })));

  // Prune dead managed sessions
  const aliveIds = new Set(snapshots.map((s) => s.id));
  for (const [id] of managedSessions) {
    if (!aliveIds.has(id)) managedSessions.delete(id);
  }

  return snapshots.map((s) => ({
    id: s.id,
    name: s.paiName ?? s.name,
    path: "",
    type: (s.name.toLowerCase().includes("claude") || !s.atPrompt) ? "claude" as const : "terminal" as const,
    paiName: s.paiName,
    atPrompt: s.atPrompt,
  }));
}

// ── Session Creation ──

export function createClaudeSession(command = "claude"): string | null {
  try {
    const script = `tell application "iTerm2"
  tell current window
    set newTab to (create tab with default profile)
    tell newTab
      tell current session
        write text "${command.replace(/"/g, '\\"')}"
        return id
      end tell
    end tell
  end tell
end tell`;
    return runAppleScript(script) ?? null;
  } catch (err) {
    log("Failed to create session:", String(err));
    return null;
  }
}

export function createTerminalTab(command?: string): string | null {
  try {
    const writeCmd = command
      ? `write text "${command.replace(/"/g, '\\"')}"`
      : "";
    const script = `tell application "iTerm2"
  tell current window
    set newTab to (create tab with default profile)
    tell newTab
      tell current session
        ${writeCmd}
        return id
      end tell
    end tell
  end tell
end tell`;
    return runAppleScript(script) ?? null;
  } catch (err) {
    log("Failed to create terminal tab:", String(err));
    return null;
  }
}

// ── Session Lifecycle ──

export async function restartSession(itermSessionId: string, command = "claude"): Promise<void> {
  sendKeystrokeToSession(itermSessionId, 3); // Ctrl+C
  await new Promise((r) => setTimeout(r, 500));
  typeIntoSession(itermSessionId, command);
}

export function killSession(itermSessionId: string): void {
  const script = withSessionAppleScript(
    itermSessionId,
    `          close aSession\n          return "ok"`,
  );
  runAppleScript(script);
}
