/**
 * adapters/iterm/core.ts — Low-level iTerm2 AppleScript primitives.
 *
 * Foundation of all iTerm2 communication. Wraps `osascript` and `spawnSync`
 * with zero transport-specific imports.
 */

import { spawnSync } from "node:child_process";
import { log } from "../../core/log.js";

export function runAppleScript(script: string): string | null {
  const result = spawnSync("osascript", [], {
    input: script,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 4_000,
  });
  if (result.status !== 0) return null;
  return result.stdout?.toString().trim() ?? null;
}

export function stripItermPrefix(id: string | undefined): string | undefined {
  if (!id) return id;
  const colonIdx = id.lastIndexOf(":");
  return colonIdx >= 0 ? id.slice(colonIdx + 1) : id;
}

export function withSessionAppleScript(sessionId: string, body: string, fallback = 'return ""'): string {
  const escaped = sessionId.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `tell application "iTerm2"
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      repeat with aSession in sessions of aTab
        if id of aSession is "${escaped}" then
${body}
        end if
      end repeat
    end repeat
  end repeat
  ${fallback}
end tell`;
}

export function sendKeystrokeToSession(sessionId: string, asciiCode: number): boolean {
  const script = withSessionAppleScript(
    sessionId,
    `          tell aSession to write text (ASCII character ${asciiCode}) newline no\n          return "ok"`,
    'return "not_found"'
  );
  const result = runAppleScript(script);
  return result === "ok";
}

export function sendEscapeSequenceToSession(sessionId: string, dirChar: string): boolean {
  const script = withSessionAppleScript(
    sessionId,
    `          tell aSession to write text (ASCII character 27) & "[${dirChar}" newline no\n          return "ok"`,
    'return "not_found"'
  );
  const result = runAppleScript(script);
  return result === "ok";
}

export function typeIntoSession(sessionId: string, text: string): boolean {
  // Claude Code terminal can get stuck in vi normal mode.
  // Send 'i' (insert) then backspace to ensure we're in editing mode.
  sendKeystrokeToSession(sessionId, 105); // 'i'
  sendKeystrokeToSession(sessionId, 127); // backspace (DEL)
  if (!pasteTextIntoSession(sessionId, text)) return false;
  sendKeystrokeToSession(sessionId, 13);
  return true;
}

export function pasteTextIntoSession(sessionId: string, text: string): boolean {
  // Escape for AppleScript string literal. Newlines must use concatenation with
  // AppleScript's `linefeed` constant since \n isn't a valid escape in AppleScript.
  const escaped = text
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r\n/g, '" & return & "')
    .replace(/\n/g, '" & linefeed & "')
    .replace(/\r/g, '" & return & "');
  const textScript = withSessionAppleScript(
    sessionId,
    `          tell aSession to write text "${escaped}" newline no\n          return "ok"`,
    'return "not_found"'
  );
  return runAppleScript(textScript) === "ok";
}

export function findClaudeSession(): string | null {
  const script = `
tell application "iTerm2"
  set output to ""
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      repeat with aSession in sessions of aTab
        set sessionId to id of aSession
        set sessionName to name of aSession
        set output to output & sessionId & (ASCII character 9) & sessionName & linefeed
      end repeat
    end repeat
  end repeat
  return output
end tell`;

  const result = runAppleScript(script);
  if (!result) return null;

  const lines = result.split("\n").filter(Boolean);
  for (const line of lines) {
    const tabIdx = line.indexOf("\t");
    if (tabIdx < 0) continue;
    const id = line.substring(0, tabIdx);
    const name = line.substring(tabIdx + 1).toLowerCase();
    if (name.includes("claude")) {
      log(`Found claude session: ${id} ("${line.substring(tabIdx + 1)}")`);
      return id;
    }
  }
  return null;
}

export function isClaudeRunningInSession(sessionId: string): boolean {
  const script = withSessionAppleScript(
    sessionId,
    `          if (is at shell prompt of aSession) then\n            return "shell"\n          else\n            return "running"\n          end if`,
    'return "not_found"'
  );
  const result = runAppleScript(script);
  if (result === "running") return true;
  if (result === "shell") {
    log(`Session ${sessionId} is at shell prompt — Claude has exited.`);
  } else {
    log(`Session ${sessionId} not found in iTerm2.`);
  }
  return false;
}

export function isItermRunning(): boolean {
  const result = spawnSync("pgrep", ["-x", "iTerm2"], {
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 3_000,
  });
  return result.status === 0;
}

export function isItermSessionAlive(sessionId: string): boolean {
  const script = withSessionAppleScript(
    sessionId,
    `          return "alive"`,
    'return "gone"'
  );
  return runAppleScript(script) === "alive";
}

export function isScreenLocked(): boolean {
  try {
    const result = spawnSync(
      "sh",
      ["-c", "ioreg -n Root -d1 -a | grep -c CGSSessionScreenIsLocked"],
      { timeout: 3_000, encoding: "utf8" }
    );
    return parseInt((result.stdout ?? "0").trim(), 10) > 0;
  } catch {
    return false;
  }
}

export function writeToTty(ttyPath: string, text: string): boolean {
  if (!ttyPath || !ttyPath.startsWith("/dev/ttys")) {
    log(`writeToTty: invalid tty path "${ttyPath}"`);
    return false;
  }

  const statResult = spawnSync("test", ["-c", ttyPath], {
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 1_000,
  });
  if (statResult.status !== 0) {
    log(`writeToTty: device not found: ${ttyPath}`);
    return false;
  }

  const safeText = text.replace(/'/g, "'\\''");
  const writeResult = spawnSync(
    "sh",
    ["-c", `printf '%s\\n' '${safeText}' > ${ttyPath}`],
    { stdio: ["pipe", "pipe", "pipe"], timeout: 2_000 }
  );

  if (writeResult.status !== 0) {
    const stderr = writeResult.stderr?.toString().trim() ?? "";
    log(`writeToTty: failed for ${ttyPath} — ${stderr || "exit " + writeResult.status}`);
    return false;
  }

  log(`writeToTty: delivered ${text.length} chars to ${ttyPath}`);
  return true;
}

export interface SessionSnapshot {
  id: string;
  name: string;
  profileName: string;
  tabTitle: string | null;
  tty: string;
  atPrompt: boolean;
  paiName: string | null;
}

export function snapshotAllSessions(): SessionSnapshot[] {
  const script = `
tell application "iTerm2"
  set output to ""
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      repeat with aSession in sessions of aTab
        set sessionId to id of aSession
        set sessionName to name of aSession
        set sessionProfile to profile name of aSession
        set sessionTty to tty of aSession
        set isAtPrompt to (is at shell prompt of aSession)
        tell aSession
          try
            set paiName to (variable named "user.paiName")
          on error
            set paiName to ""
          end try
          try
            set tabTitle to (variable named "tab.title")
          on error
            set tabTitle to ""
          end try
        end tell
        set output to output & sessionId & (ASCII character 9) & sessionName & (ASCII character 9) & sessionProfile & (ASCII character 9) & sessionTty & (ASCII character 9) & (isAtPrompt as text) & (ASCII character 9) & paiName & (ASCII character 9) & tabTitle & linefeed
      end repeat
    end repeat
  end repeat
  return output
end tell`;

  const result = runAppleScript(script);
  if (!result) return [];

  const sessions: SessionSnapshot[] = [];
  for (const line of result.split("\n").filter(Boolean)) {
    const parts = line.split("\t");
    if (parts.length < 5) continue;
    sessions.push({
      id: parts[0],
      name: parts[1],
      profileName: parts[2],
      tabTitle: (parts[6] && parts[6] !== "missing value" && parts[6] !== "") ? parts[6] : null,
      tty: parts[3],
      atPrompt: parts[4] === "true",
      paiName: (parts[5] && parts[5] !== "missing value" && parts[5] !== "") ? parts[5] : null,
    });
  }
  return sessions;
}
