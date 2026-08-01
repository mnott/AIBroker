/**
 * adapters/iterm/core.ts — Low-level iTerm2 AppleScript primitives.
 *
 * Foundation of all iTerm2 communication. Wraps `osascript` and `spawnSync`
 * with zero transport-specific imports.
 */

import { spawnSync } from "node:child_process";
import { log } from "../../core/log.js";

/**
 * Throttle identical failures so a persistent fault logs steadily, not per-poll —
 * but COUNT the suppressed ones and say how many.
 *
 * Throttling alone loses the rate, and the rate is the diagnosis. Two failures
 * a minute and two thousand a minute produce an identical log at a 30s throttle,
 * so a flapping fault reads the same as an occasional one. This is the same
 * trap as a deferral that is logged but not counted: the record exists and
 * still cannot tell you whether the thing is nearly fine or completely broken.
 */
const lastLogged = new Map<string, number>();
const suppressed = new Map<string, number>();

function logThrottled(key: string, message: string): void {
  const now = Date.now();
  const prev = lastLogged.get(key) ?? 0;
  if (now - prev < 30_000) {
    suppressed.set(key, (suppressed.get(key) ?? 0) + 1);
    return;
  }
  const hidden = suppressed.get(key) ?? 0;
  suppressed.set(key, 0);
  lastLogged.set(key, now);
  log(hidden > 0 ? `${message} (+${hidden} more in the last ${Math.round((now - prev) / 1000)}s)` : message);
}

// Default budget. Deliberately generous: exceeding it yields null, which every
// caller turns into "nothing there" rather than "I could not tell", so a tight
// default trades a rare slow call for a silent wrong answer. iTerm AppleScript
// cost scales with open sessions and scrollback, both of which grow over time.
export function runAppleScript(script: string, timeoutMs = 15_000): string | null {
  const result = spawnSync("osascript", [], {
    input: script,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: timeoutMs,
  });

  if (result.status !== 0 || result.error) {
    // NEVER fail silently here. Every session feature — send_to_session,
    // session_content, dispatch — is built on this call, and a null turns into
    // an empty session list that is indistinguishable from "nothing is open".
    // A timeout 50ms over budget therefore looked exactly like an empty
    // machine, and took the whole hub down with nothing in the log to show it.
    const first = script.trim().split("\n")[0].slice(0, 60);
    const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT"
      || result.signal === "SIGTERM";
    const stderr = result.stderr?.toString().trim().slice(0, 200) ?? "";
    logThrottled(
      `${first}|${timedOut}`,
      timedOut
        ? `osascript TIMED OUT after ${timeoutMs}ms — callers will see an empty result. Script: ${first}…`
        : `osascript failed (status ${result.status}${result.signal ? `, signal ${result.signal}` : ""})` +
          `${stderr ? `: ${stderr}` : ""}. Script: ${first}…`,
    );
    return null;
  }

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
  /**
   * Durable, transport-stable id. For tmux this is the pane's @aibroker_id
   * (survives server restarts, unlike the volatile %N pane id). For iTerm it is
   * undefined — the GUID in `id` is already stable. Persistent-name lookups key
   * on this when present so a tmux session keeps its name across %N churn.
   */
  aibrokerId?: string | null;
}

/**
 * snapshotAllSessions — Fast enumeration of all iTerm2 sessions.
 *
 * Single AppleScript pass: id, name, tty, tab.title per session.
 * ~1.5s for 16 sessions (vs >30s timeout with the old combined script).
 *
 * What is still dropped vs the original (kept out for speed):
 * - `is at shell prompt`: adds ~180ms/session (3.3s for 18). Derived from name instead.
 * - `profile name`: ~0.6s overhead, always "Default" in practice.
 * - `variable named "user.paiName"`: paiName is read from ~/.aibroker/session-names.json
 *   by the caller via getAllPersistentSessionNames() — authoritative, no iTerm corruption.
 *
 * `tab.title` IS fetched (one variable read, measured ~1.5s total for 16 sessions). It was
 * wrongly dropped in v0.7.10, which collapsed the display precedence `paiName ?? tabTitle ?? name`
 * down to `paiName ?? name` — so any session without a persistent paiName rendered the raw
 * iTerm process string ("claude (node)") instead of its tab title. Restoring it fixes that.
 *
 * atPrompt heuristic: iTerm2's title reporter encodes the foreground process in the
 * tab name — "(node)" = Claude Code running (not at prompt). "(-zsh)", "(-bash)",
 * "(ssh)", bare path names = shell at prompt. Accurate for sessions display.
 */
export function snapshotAllSessions(): SessionSnapshot[] {
  // Fetch id, name, tty, tab.title. Skip `profile name` (~0.6s) and
  // `is at shell prompt` (~3.3s) — both derived or irrelevant.
  const script = `
tell application "iTerm2"
  set output to ""
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      repeat with aSession in sessions of aTab
        set sessionId to id of aSession
        set sessionName to name of aSession
        set sessionTty to tty of aSession
        tell aSession
          try
            set tabTitle to (variable named "tab.title")
          on error
            set tabTitle to ""
          end try
        end tell
        set output to output & sessionId & (ASCII character 9) & sessionName & (ASCII character 9) & sessionTty & (ASCII character 9) & tabTitle & linefeed
      end repeat
    end repeat
  end repeat
  return output
end tell`;

  // Timeout scales with the work: iTerm's AppleScript cost grows with the
  // number of open sessions, so a fixed budget silently expires as the user
  // opens more tabs. A previous 4s constant was measured at ~1.5s for 16
  // sessions and called "safe headroom"; at 22 sessions the same script took
  // 4.05s and every enumeration returned empty, killing all session features
  // at once. Budget generously — this is a correctness floor, not a latency
  // target, and a slow answer beats a confidently wrong empty one.
  const result = runAppleScript(script, 30_000);
  if (!result) return [];

  const sessions: SessionSnapshot[] = [];
  for (const line of result.split("\n").filter(Boolean)) {
    const parts = line.split("\t");
    if (parts.length < 4) continue;
    const name = parts[1];
    // Derive atPrompt from name heuristic: "(node)" = Claude Code running (not at prompt).
    // "(-zsh)", "(-bash)", "(ssh)", bare path = at shell prompt.
    const atPrompt = !name.includes("(node)") && !name.includes("(npm)") && !name.includes("(bun)");
    sessions.push({
      id: parts[0],
      name,
      profileName: "Default",   // profile name skipped for speed; always "Default" in practice
      tty: parts[2],
      atPrompt,
      tabTitle: (parts[3] && parts[3] !== "missing value" && parts[3] !== "") ? parts[3] : null,
      // paiName is null here — callers merge from getAllPersistentSessionNames()
      paiName: null,
    });
  }
  return sessions;
}

/**
 * Clear the user.paiName variable from all live iTerm2 sessions.
 * Used for recovery when session names are corrupt.
 * Does a single AppleScript pass over all sessions.
 */
export function clearAllPaiNames(): number {
  const script = `
tell application "iTerm2"
  set cleared to 0
  repeat with aWindow in windows
    repeat with aTab in tabs of aWindow
      repeat with aSession in sessions of aTab
        tell aSession
          try
            set variable named "user.paiName" to ""
            set cleared to cleared + 1
          end try
        end tell
      end repeat
    end repeat
  end repeat
  return cleared
end tell`;
  // Allow 10s since this iterates all sessions with variable writes
  const result = runAppleScript(script, 10_000);
  return result ? parseInt(result, 10) || 0 : 0;
}
