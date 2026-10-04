/**
 * adapters/iterm/core.ts — Low-level iTerm2 AppleScript primitives.
 *
 * Foundation of all iTerm2 communication. Wraps `osascript` and `spawnSync`
 * with zero transport-specific imports.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { statSync, writeFileSync } from "node:fs";
import { log } from "../../core/log.js";
import { timeCall } from "../../core/call-timing.js";
import { itermInPlay } from "../../transport/policy.js";

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

/**
 * Environment for any child that can touch AppKit. iTerm exports
 * __CFBundleIdentifier into its shells; a child that inherits it registers with
 * LaunchServices AS iTerm2 (an "impostor") for as long as it runs.
 */
export function cleanChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { __CFBundleIdentifier: _drop, ...rest } = env;
  return rest;
}

/** Run osascript with a script on stdin; null (and a throttled log line) on any failure. */
function runOsascript(args: string[], script: string, timeoutMs: number): string | null {
  const result = spawnSync("osascript", args, {
    input: script,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: timeoutMs,
    env: cleanChildEnv(),
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

// Default budget. Deliberately generous: exceeding it yields null, which every
// caller turns into "nothing there" rather than "I could not tell", so a tight
// default trades a rare slow call for a silent wrong answer. iTerm AppleScript
// cost scales with open sessions and scrollback, both of which grow over time.
// For OTHER apps only — iTerm is addressed through runItermJxa.
export function runAppleScript(script: string, timeoutMs = 15_000): string | null {
  // No osascript off macOS — not a failure, so nothing to log or throttle.
  if (process.platform !== "darwin") return null;
  return runOsascript([], script, timeoutMs);
}

export const REAL_ITERM_SUFFIX = "/iTerm.app/Contents/MacOS/iTerm2";

/**
 * Parser half of itermPid(), split out for testing. Input is `ps -Ao pid=,comm=`;
 * only a process whose executable is iTerm's own is accepted, so a bundle-id
 * impostor (osascript/helper that inherited __CFBundleIdentifier) is never picked.
 */
export function parseItermPid(psOutput: string): number | null {
  for (const line of psOutput.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(.+?)\s*$/);
    if (m && m[2].endsWith(REAL_ITERM_SUFFIX)) return parseInt(m[1], 10);
  }
  return null;
}

let cachedItermPid: number | null = null;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Pid of the real iTerm (cached, re-resolved once that pid is gone); null when it is not running. */
export function itermPid(): number | null {
  if (process.platform !== "darwin") return null;
  if (cachedItermPid !== null && pidAlive(cachedItermPid)) return cachedItermPid;
  cachedItermPid = null;
  const ps = spawnSync("ps", ["-Ao", "pid=,comm="], { encoding: "utf8", timeout: 5_000 });
  if (ps.status !== 0 || !ps.stdout) return null;
  cachedItermPid = parseItermPid(ps.stdout);
  return cachedItermPid;
}

/** The JXA program run for a body: `app` is bound to the real iTerm process, the body returns a string. */
export function buildItermJxa(pid: number, body: string): string {
  return `(function () {\n  var app = Application(${pid});\n${body}\n})()`;
}

/**
 * Run JXA against iTerm, addressed by PROCESS ID — never by name, bundle id or
 * path, all of which LaunchServices resolves through the bundle-id registry
 * that an impostor process poisons (-600 / -1708). The body sees `app` and
 * must `return` a string. Same failure value as runAppleScript: null.
 */
export function runItermJxa(body: string, timeoutMs = 15_000): string | null {
  const pid = itermPid();
  if (pid === null) return null;
  const out = runOsascript(["-l", "JavaScript"], buildItermJxa(pid, body), timeoutMs);
  if (out === null) cachedItermPid = null; // maybe iTerm restarted; resolve afresh next time
  return out;
}

/**
 * Plain-object indirection so tests can replace the osascript call without
 * mocking node:child_process — a builtin's named export is a fixed snapshot
 * taken once at module load, so reassigning it post-load (the usual mock
 * technique) silently does nothing.
 */
export const _internal = { runAppleScript, runItermJxa };

export function stripItermPrefix(id: string | undefined): string | undefined {
  if (!id) return id;
  const colonIdx = id.lastIndexOf(":");
  return colonIdx >= 0 ? id.slice(colonIdx + 1) : id;
}

/**
 * JXA body that finds the session with this id and runs `body` on it.
 * `body` sees `app`, `aWindow`, `aTab`, `aSession` and must `return` a string;
 * `fallback` is a JS expression returned when no session matches.
 */
export function withSessionJxa(sessionId: string, body: string, fallback = '""'): string {
  return `  var wanted = ${JSON.stringify(sessionId)};
  var windows = app.windows();
  for (var wi = 0; wi < windows.length; wi++) {
    var aWindow = windows[wi];
    var tabs = aWindow.tabs();
    for (var ti = 0; ti < tabs.length; ti++) {
      var aTab = tabs[ti];
      var sessions = aTab.sessions();
      for (var si = 0; si < sessions.length; si++) {
        var aSession = sessions[si];
        if (aSession.id() === wanted) {
${body}
        }
      }
    }
  }
  return ${fallback};`;
}

/** Type raw text into a session as though typed, without a trailing newline. */
function writeToSession(sessionId: string, textJs: string): boolean {
  const body = withSessionJxa(
    sessionId,
    `          aSession.write({ text: ${textJs}, newline: false });\n          return "ok";`,
    '"not_found"',
  );
  return runItermJxa(body) === "ok";
}

export function sendKeystrokeToSession(sessionId: string, asciiCode: number): boolean {
  return writeToSession(sessionId, `String.fromCharCode(${asciiCode})`);
}

export function sendEscapeSequenceToSession(sessionId: string, dirChar: string): boolean {
  return writeToSession(sessionId, JSON.stringify(`\x1b[${dirChar}`));
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
  return writeToSession(sessionId, JSON.stringify(text));
}

export function findClaudeSession(): string | null {
  const script = `  var out = "";
  app.windows().forEach(function (w) { w.tabs().forEach(function (t) { t.sessions().forEach(function (s) {
    out += s.id() + "\\t" + s.name() + "\\n";
  }); }); });
  return out;`;

  const result = runItermJxa(script);
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
  const script = withSessionJxa(
    sessionId,
    `          return aSession.isAtShellPrompt() ? "shell" : "running";`,
    '"not_found"',
  );
  const result = runItermJxa(script);
  if (result === "running") return true;
  if (result === "shell") {
    log(`Session ${sessionId} is at shell prompt — Claude has exited.`);
  } else {
    log(`Session ${sessionId} not found in iTerm2.`);
  }
  return false;
}

export function isItermRunning(): boolean {
  if (!itermInPlay()) return false;
  const result = spawnSync("pgrep", ["-x", "iTerm2"], {
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 3_000,
  });
  return result.status === 0;
}

export function isItermSessionAlive(sessionId: string): boolean {
  const script = withSessionJxa(sessionId, `          return "alive";`, '"gone"');
  return runItermJxa(script) === "alive";
}

export function isScreenLocked(): boolean {
  if (process.platform !== "darwin") return false;
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

/**
 * Write a line to a tty device.
 *
 * This used to build `sh -c "printf '%s\n' '<text>' > <ttyPath>"`. Two things
 * were wrong with that. The path was interpolated unquoted, so everything after
 * the `/dev/ttys` prefix the check required was shell syntax rather than a
 * filename. And the text — arbitrary inbound WhatsApp/Telegram/Todoist content —
 * was held inside single quotes by one hand-rolled escape that had to stay
 * exactly right forever. Neither risk is worth running a shell to copy bytes
 * into a file descriptor, so it no longer runs one.
 */
export function writeToTty(ttyPath: string, text: string): boolean {
  if (!/^\/dev\/ttys[A-Za-z0-9]+$/.test(ttyPath)) {
    log(`writeToTty: invalid tty path "${ttyPath}"`);
    return false;
  }

  try {
    if (!statSync(ttyPath).isCharacterDevice()) {
      log(`writeToTty: not a character device: ${ttyPath}`);
      return false;
    }
    writeFileSync(ttyPath, text + "\n");
  } catch (err) {
    log(`writeToTty: failed for ${ttyPath} — ${(err as Error).message}`);
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
  /** Working directory, when the host reports it (tmux). Absent on iTerm. */
  cwd?: string | null;
  /** Host this row came from; absent means iTerm. */
  transport?: "iterm" | "tmux";
  /**
   * Whether a Claude is actually running on this terminal, read from the
   * process table. Undefined when that could not be read — a caller must then
   * fall back to guessing from the title rather than treat "unknown" as "no".
   */
  isClaude?: boolean;
  /**
   * True for a `pai worker follow` pane (iTerm variable `user.paiWorkerPane`
   * set). Kept in the snapshot for internal lookups; list surfaces drop it.
   */
  workerPane?: boolean;
}

/**
 * snapshotAllSessions — Fast enumeration of all iTerm2 sessions.
 *
 * Single JXA pass: id, name, tty, tab.title per session.
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
/**
 * Which terminals have a Claude running on them, asked of the process table.
 *
 * The alternative was reading the window title, and a title is a rumour: it
 * tracks whatever the foreground process last called itself, so the launcher —
 * `node …/pai`, sitting in its picker — was titled `pai (node)`, matched the
 * "(node) means Claude" heuristic, and listed ITSELF as a session. It could not
 * be named, could not be dispatched to, and reappeared under a new id every
 * time the picker was opened.
 *
 * One `ps` for the whole table, not one per session: this runs on every
 * enumeration, and a call per pane would multiply by however many tabs are
 * open — the same shape of mistake as the AppleScript timeout that scaled with
 * tab count.
 */
function ttysRunningClaude(): Set<string> {
  const found = new Set<string>();
  try {
    const out = timeCall("iterm-core:ps-claude-scan", () =>
      execFileSync("ps", ["-ao", "tty=,command="], { encoding: "utf8", timeout: 10_000 }));
    for (const line of out.split("\n")) {
      const m = line.match(/^\s*(\S+)\s+(.*)$/);
      if (!m) continue;
      const [, tty, command] = m;
      // The binary, not a path that merely mentions it: an MCP server living
      // under a .claude directory is not a session.
      if (/(^|\/)claude(\s|$)/.test(command)) found.add(tty.startsWith("/dev/") ? tty : `/dev/${tty}`);
    }
  } catch {
    /* no answer: callers fall back to the title heuristic rather than see nothing */
  }
  return found;
}

/**
 * Reuse window for one enumeration, mirroring HybridSessionManager's own
 * SYNC_COALESCE_MS (core/hybrid.ts) — same fix, same number, because this is
 * the function that manager's own coalescing was built to protect. It only
 * covers callers that go through `discover()`; every other caller (hub IPC
 * `status`/`aibp_status`/`send_to_session`, PAILot's per-message session-name
 * lookups, the MQTT "sessions"/"refresh" handler) calls this directly and was
 * paying the full ~1.5-4s osascript+ps cost on every single request, back to
 * back, which is what was blocking the daemon's one event loop.
 */
const SNAPSHOT_TTL_MS = 3_000;
let cachedSnapshots: SessionSnapshot[] | null = null;
let cachedAt = 0;

/**
 * True enumeration, always uncached. Split out so callers that must see a
 * mutation they just made (e.g. a session removed 600ms ago) can bypass the
 * memo via `snapshotAllSessions({ fresh: true })` instead of waiting out the
 * TTL.
 */
function snapshotAllSessionsUncached(): SessionSnapshot[] {
  // iTerm is not in play (tmux transport / non-macOS): an empty answer, and a
  // reliable one — "no iTerm sessions" is true, not a dropped enumeration.
  if (!itermInPlay()) {
    lastSnapshotOk = true;
    return [];
  }
  // Fetch id, name, tty, tab.title. Skip `profile name` (~0.6s) and
  // `is at shell prompt` (~3.3s) — both derived or irrelevant.
  const script = `  var out = "";
  app.windows().forEach(function (w) { w.tabs().forEach(function (t) { t.sessions().forEach(function (s) {
    var tabTitle = "";
    try { tabTitle = s.variable({ named: "tab.title" }); } catch (e) {}
    var workerPane = "";
    try { workerPane = s.variable({ named: "user.paiWorkerPane" }) || ""; } catch (e) {}
    out += [s.id(), s.name(), s.tty(), tabTitle, workerPane].join("\\t") + "\\n";
  }); }); });
  return out;`;

  // Timeout scales with the work: iTerm's AppleScript cost grows with the
  // number of open sessions, so a fixed budget silently expires as the user
  // opens more tabs. A previous 4s constant was measured at ~1.5s for 16
  // sessions and called "safe headroom"; at 22 sessions the same script took
  // 4.05s and every enumeration returned empty, killing all session features
  // at once. Budget generously — this is a correctness floor, not a latency
  // target, and a slow answer beats a confidently wrong empty one.
  const result = timeCall("iterm-core:snapshot-enum", () => _internal.runItermJxa(script, 30_000));
  if (!result) {
    lastSnapshotOk = false;
    return [];
  }
  lastSnapshotOk = true;

  const claudeTtys = ttysRunningClaude();
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
      // Measured, where the title was only guessed. Undefined when the process
      // table could not be read, so callers keep their old heuristic rather
      // than conclude that nothing is a session.
      isClaude: claudeTtys.size ? claudeTtys.has(parts[2]) : undefined,
      // paiName is null here — callers merge from getAllPersistentSessionNames()
      paiName: null,
      workerPane: Boolean(parts[4]) && parts[4] !== "missing value",
    });
  }
  return sessions;
}

/**
 * Whether the LAST enumeration actually talked to iTerm, or fell back to `[]`
 * because osascript errored. A dispatcher that reads an empty array as "no
 * session, safe to launch" cannot tell a truly empty machine from an iTerm
 * that failed to answer — this is the flag that lets it tell them apart.
 * Never true while a failed `[]` sits in the cache — see snapshotAllSessions.
 */
let lastSnapshotOk = true;

export function wasLastSnapshotReliable(): boolean {
  return lastSnapshotOk;
}

export interface ItermBundleIdImpostor {
  pid: number;
  executablePath: string;
}

/**
 * Parser half of findItermBundleIdImpostors(), split out for testing without
 * a subprocess. `lsappinfo list` entries look like:
 *   125) "iTerm2" ASN:0x0-0x412ec2ab: (in front)
 *       bundleID="com.googlecode.iterm2"
 *       executable path="/Applications/iTerm.app/Contents/MacOS/iTerm2"
 *       pid = 66665 ...
 * A child launched with iTerm's exported __CFBundleIdentifier registers under
 * the same bundle id from a different executable — that mismatch is the tell.
 */
export function parseLsappinfoImpostors(text: string): ItermBundleIdImpostor[] {
  const impostors: ItermBundleIdImpostor[] = [];
  const entries = text.split(/\n(?=[ \t]*\d+\)\s)/);
  for (const entry of entries) {
    const bundleMatch = entry.match(/bundleID="([^"]*)"/);
    if (!bundleMatch || bundleMatch[1] !== "com.googlecode.iterm2") continue;
    const pathMatch = entry.match(/executable path="([^"]*)"/);
    const pidMatch = entry.match(/pid\s*=\s*(\d+)/);
    if (!pathMatch || !pidMatch) continue;
    const executablePath = pathMatch[1];
    if (executablePath.endsWith(REAL_ITERM_SUFFIX)) continue;
    impostors.push({ pid: parseInt(pidMatch[1], 10), executablePath });
  }
  return impostors;
}

/**
 * Processes registered with LaunchServices under iTerm2's bundle id but NOT
 * running iTerm's own executable — e.g. an osascript/helper child that
 * inherited iTerm's __CFBundleIdentifier env var. While registered, anything
 * addressing iTerm by name or bundle id is routed to the impostor, which answers
 * with -600/-1708 (iTerm itself is addressed by pid, so it is immune). Diagnostic only: never kills
 * anything, never throws — on any error this is "found nothing" to a caller
 * that already treats [] as the safe default.
 */
export function findItermBundleIdImpostors(): ItermBundleIdImpostor[] {
  if (!itermInPlay()) return [];
  try {
    const result = spawnSync("/usr/bin/lsappinfo", ["list"], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 3_000,
      encoding: "utf8",
    });
    if (result.status !== 0 || result.error || !result.stdout) return [];
    return parseLsappinfoImpostors(result.stdout);
  } catch {
    return [];
  }
}

/**
 * Enumerate all iTerm2 sessions, reusing an answer up to SNAPSHOT_TTL_MS old.
 *
 * A failed enumeration (osascript error/timeout) is NEVER memoized: it used to
 * be cached the same as a real `[]`, so one bad poll made every session
 * "not found" for the full TTL window — observed live, `send_to_session`
 * reported an empty session list for a target that a listing seconds later
 * (past the TTL) showed as one of 14 live sessions. A failure now leaves the
 * previous good snapshot in place (or null, if there was none), so the next
 * call retries iTerm instead of replaying the failure.
 */
export function snapshotAllSessions(opts: { fresh?: boolean } = {}): SessionSnapshot[] {
  const now = Date.now();
  if (!opts.fresh && cachedSnapshots && now - cachedAt < SNAPSHOT_TTL_MS) return cachedSnapshots;
  const result = snapshotAllSessionsUncached();
  if (lastSnapshotOk) {
    cachedSnapshots = result;
    cachedAt = now;
  }
  return result;
}

/** Force the next snapshotAllSessions() to re-enumerate rather than reuse. */
export function invalidateSnapshotCache(): void {
  cachedSnapshots = null;
}

/**
 * Clear the user.paiName variable from all live iTerm2 sessions.
 * Used for recovery when session names are corrupt.
 * Does a single AppleScript pass over all sessions.
 */
export function clearAllPaiNames(): number {
  const script = `  var cleared = 0;
  app.windows().forEach(function (w) { w.tabs().forEach(function (t) { t.sessions().forEach(function (s) {
    try { s.setVariable({ named: "user.paiName", to: "" }); cleared++; } catch (e) {}
  }); }); });
  return String(cleared);`;
  // Allow 10s since this iterates all sessions with variable writes
  const result = runItermJxa(script, 10_000);
  return result ? parseInt(result, 10) || 0 : 0;
}
