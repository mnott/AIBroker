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
import { saveSessionRegistry, getAllPersistentSessionNames, lookupPersistentName } from "../../core/persistence.js";

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

/**
 * Bring a session to the front by its iTerm2 unique ID.
 *
 * Returns false when no session carries that ID — which is the answer a caller
 * needs in order to fall back to relaunching, rather than reporting a dead
 * session as an unexplained failure.
 */
export function revealItermSession(itermSessionId: string): boolean {
  try {
    const result = execSync(
      `osascript -e 'tell application "iTerm2"
        repeat with w in windows
          repeat with t in tabs of w
            repeat with s in sessions of t
              if (unique ID of s) is "${itermSessionId.replace(/"/g, "")}" then
                select w
                select t
                select s
                activate
                return "ok"
              end if
            end repeat
          end repeat
        end repeat
        return "no"
      end tell'`,
      { timeout: 5000, encoding: "utf8", shell: "/bin/bash" },
    ).trim();
    return result === "ok";
  } catch {
    return false;
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
  const persistentNames = getAllPersistentSessionNames();
  return sessions
    .filter((s) => s.name.toLowerCase().includes("claude") || lookupPersistentName(persistentNames, s.id, s.aibrokerId))
    .map((s) => ({ id: s.id, name: lookupPersistentName(persistentNames, s.id, s.aibrokerId) ?? s.name }));
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
  const persistentNames = getAllPersistentSessionNames();

  // Update TTY cache
  updateSessionTtyCache(snapshots.map((s) => ({ id: s.id, tty: s.tty })));

  // Prune dead managed sessions
  const aliveIds = new Set(snapshots.map((s) => s.id));
  for (const [id] of managedSessions) {
    if (!aliveIds.has(id)) managedSessions.delete(id);
  }

  return snapshots.map((s) => {
    const paiName = lookupPersistentName(persistentNames, s.id, s.aibrokerId);
    return {
      id: s.id,
      name: paiName ?? s.name,
      path: "",
      type: (s.name.toLowerCase().includes("claude") || !s.atPrompt) ? "claude" as const : "terminal" as const,
      paiName,
      atPrompt: s.atPrompt,
    };
  });
}

// ── Session Creation ──

/**
 * AppleScript that lands on a usable session, whatever state the app is in.
 *
 * `current window` is not always there. With the screen locked no window is
 * key, and an app launched by the AppleScript itself has none at all — both
 * answer `missing value`, and `create tab` on that fails with -1728, which the
 * caller could only report as "failed to create a tab". A scheduled run then
 * dies for the sole reason that nobody happened to be looking at the machine.
 *
 * So: the frontmost window if there is one, otherwise any window, otherwise a
 * new window — which arrives with a session already in it, so there is nothing
 * to create inside it.
 *
 * `create tab` CAN ALSO ANSWER `missing value` on a window that genuinely
 * exists — a hotkey window, or one whose profile will not host another tab.
 * The original guard covered the window and then dereferenced the tab
 * unchecked, so that case failed with the very error the guard was added to
 * prevent, one level down: `Can't get current session of missing value`
 * (-1728), thrown at `tell newTab`.
 *
 * Measured cost, 2026-08-07 to 2026-08-11: 471 failed launches for one project
 * and 193 for another. Three strikes park a task, so both daily sweeps and an
 * application task stopped running entirely and stayed parked for four days.
 *
 * A window that cannot take a tab is not a reason to fail — a new window is
 * always available and always arrives with a session in it. So the tab result
 * is now checked, and falls back to the same new-window path the no-window
 * case already used.
 */
function openSessionScript(command: string): string {
  const write = command ? `write text "${command.replace(/"/g, '\\"')}"` : "";
  // One place to describe "a brand-new window, which comes with a session".
  const viaNewWindow = `set targetWindow to (create window with default profile)
    if targetWindow is missing value then error "iTerm2 would not create a window" number -1728
    tell targetWindow
      tell current session
        ${write}
        return id
      end tell
    end tell`;
  return `tell application "iTerm2"
  set targetWindow to missing value
  try
    set targetWindow to current window
  end try
  if targetWindow is missing value and (count of windows) > 0 then
    set targetWindow to item 1 of windows
  end if
  if targetWindow is missing value then
    ${viaNewWindow}
  else
    set newTab to missing value
    try
      tell targetWindow
        set newTab to (create tab with default profile)
      end tell
    end try
    if newTab is missing value then
      ${viaNewWindow}
    else
      tell newTab
        tell current session
          ${write}
          return id
        end tell
      end tell
    end if
  end if
end tell`;
}

export function createClaudeSession(command = "claude"): string | null {
  try {
    return runAppleScript(openSessionScript(command)) ?? null;
  } catch (err) {
    log("Failed to create session:", String(err));
    return null;
  }
}

export function createTerminalTab(command?: string): string | null {
  try {
    return runAppleScript(openSessionScript(command ?? "")) ?? null;
  } catch (err) {
    log("Failed to create terminal tab:", String(err));
    return null;
  }
}

// ── Session Lifecycle ──

export async function restartSession(itermSessionId: string, command = "claude"): Promise<void> {
  sendKeystrokeToSession(itermSessionId, 3); // Ctrl+C
  await new Promise((r) => setTimeout(r, 500));
  // Uses the RAW core primitive, not the guarded facade, deliberately:
  // addressing a shell is the whole point here — Ctrl+C has just dropped this
  // tab out of Claude so the launch command can be typed into it.
  typeIntoSession(itermSessionId, command);
}

export function killSession(itermSessionId: string): void {
  const script = withSessionAppleScript(
    itermSessionId,
    `          close aSession\n          return "ok"`,
  );
  runAppleScript(script);
}
