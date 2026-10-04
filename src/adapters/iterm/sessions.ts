/**
 * adapters/iterm/sessions.ts — Higher-level iTerm2 session management.
 *
 * Session variables, tab naming, discovery, creation, and lifecycle.
 * Does NOT import any transport send functions — callers handle message delivery.
 */

import { execSync } from "node:child_process";
import { basename } from "node:path";

import {
  runItermJxa,
  _internal,
  isItermRunning,
  isClaudeRunningInSession,
  isItermSessionAlive,
  typeIntoSession,
  sendKeystrokeToSession,
  stripItermPrefix,
  withSessionJxa,
  snapshotAllSessions,
  type SessionSnapshot,
} from "./core.js";
import {
  setSessionTitle,
  itermViewerSessionId,
  snapshotAllSessions as snapshotAllTransports,
} from "../../transport/sync-facade.js";
import { itermInPlay } from "../../transport/policy.js";
import { normaliseLabel } from "../../core/session-match.js";
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
  if (!itermInPlay()) return;
  runItermJxa(withSessionJxa(itermSessionId, `          ${body}\n          return "ok";`), 5_000);
}

export function setItermSessionVar(itermSessionId: string, name: string): void {
  const value = JSON.stringify(name.replace(/[\n\r]/g, " "));
  setItermSessionProperty(itermSessionId, `aSession.setVariable({ named: "user.paiName", to: ${value} });`);
}

export function setItermTabName(itermSessionId: string, name: string): void {
  if (!itermInPlay()) return;
  // Fire-and-forget: rename the tab via iTerm2's native WebSocket API.
  // This sets the persistent title override (same as double-click rename).
  import("./iterm2-api.js").then(({ iterm2SetTabTitle }) =>
    iterm2SetTabTitle(itermSessionId, name).catch((err) =>
      log(`Tab rename failed: ${err instanceof Error ? err.message : String(err)}`),
    ),
  );
}

export function setItermBadge(itermSessionId: string, text: string): void {
  if (!itermInPlay()) return;
  // Write badge escape sequence to the session's tty device.
  // Must go to terminal output stream (not stdin via "write text").
  try {
    const tty = (runItermJxa(
      withSessionJxa(itermSessionId, `          return aSession.tty();`),
      5_000,
    ) ?? "").trim();
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
  if (!itermInPlay()) return false;
  try {
    const result = runItermJxa(withSessionJxa(
      itermSessionId,
      `          aWindow.select(); aTab.select(); aSession.select(); app.activate();\n          return "ok";`,
      '"no"',
    ), 5_000);
    return result === "ok";
  } catch {
    return false;
  }
}

export function getItermSessionVar(itermSessionId: string): string | null {
  if (!itermInPlay()) return null;
  const result = runItermJxa(withSessionJxa(
    itermSessionId,
    `          try { return aSession.variable({ named: "user.paiName" }) || ""; } catch (e) { return ""; }`,
  ), 5_000);
  return (result && result !== "missing value") ? result : null;
}

// ── Name Authority ──
// A user-chosen name outranks every generated one. Claude Code's auto-titler
// re-stamps the tab title on every turn, so a name set once by the rename
// handler survives only until that turn — unless the daemon gets the last
// word. That is reassertPersistentTitles, run from an interval in the daemon.

/**
 * Re-write chosen names onto tabs whose title has materially diverged.
 *
 * "Materially" is judged after normaliseLabel() strips the benign decorations
 * (spinner glyph prefix, "(node)"/"(claude)" process suffix): a busy marker on
 * the right name is not divergence, an auto-title "Name-smooth-fiddle" is.
 * Case and separators already fold, so only a real takeover triggers a write.
 *
 * Setters are injectable so tests observe the writes instead of performing
 * them; the production defaults are exactly what the rename handler uses.
 * Returns the count actually re-pinned — 0 means every surface already agrees.
 */
export function reassertPersistentTitles(
  deps: {
    sessions?: SessionSnapshot[];
    setTabName?: (id: string, name: string) => void;
    setSessionVar?: (id: string, name: string) => void;
    setBadge?: (id: string, name: string) => void;
    setPaneTitle?: (id: string, name: string) => boolean;
    viewerFor?: (paneId: string) => string | null;
  } = {},
): number {
  const setTabName = deps.setTabName ?? setItermTabName;
  const setSessionVar = deps.setSessionVar ?? setItermSessionVar;
  const setBadge = deps.setBadge ?? setItermBadge;
  const setPaneTitle = deps.setPaneTitle ?? setSessionTitle;
  const viewerFor = deps.viewerFor ?? itermViewerSessionId;
  const sessions = deps.sessions ?? snapshotAllTransports();

  const names = getAllPersistentSessionNames();
  let repinned = 0;
  for (const s of sessions) {
    const chosen = lookupPersistentName(names, s.id, s.aibrokerId);
    if (!chosen) continue;
    const title = s.tabTitle ?? s.name;
    if (normaliseLabel(title) === normaliseLabel(chosen)) continue;

    if (s.aibrokerId) {
      // tmux-hosted: the pane title, plus — if an iTerm tab is viewing it —
      // that tab, exactly the surfaces the rename handler touches.
      setPaneTitle(s.id, chosen);
      const viewer = viewerFor(s.id);
      if (viewer) {
        setSessionVar(viewer, chosen);
        setTabName(viewer, chosen);
        setBadge(viewer, chosen);
      }
    } else {
      setSessionVar(s.id, chosen);
      setTabName(s.id, chosen);
      setBadge(s.id, chosen);
    }
    log(`Name authority: re-pinned "${chosen}" over tab title "${title}" (session ${s.id.slice(0, 8)})`);
    repinned += 1;
  }
  return repinned;
}

/**
 * The name an AUTO path (launch fallback, re-home default) may write: the
 * chosen name if the session has one, else the generated fallback. Launch
 * paths can be handed a reused live tab (see openSessionScript's busy guard),
 * and a generated name must not displace what the user chose there.
 */
export function autoTabName(sessionId: string, fallback: string): string {
  return lookupPersistentName(getAllPersistentSessionNames(), sessionId) ?? fallback;
}

// ── Session Resolution ──

export function findItermSessionForTermId(
  termSessionId: string,
  itermSessionIdHint?: string,
): string | null {
  if (itermSessionIdHint) {
    return stripItermPrefix(itermSessionIdHint) ?? itermSessionIdHint;
  }

  const script = `  var wanted = ${JSON.stringify(termSessionId)};
  var found = "";
  app.windows().forEach(function (w) { w.tabs().forEach(function (t) { t.sessions().forEach(function (s) {
    if (found) return;
    var v = "";
    try { v = s.variable({ named: "TERM_SESSION_ID" }); } catch (e) {}
    if (v === wanted) found = s.id();
  }); }); });
  return found;`;

  const result = runItermJxa(script);
  return (result && result.length > 0) ? result : null;
}

// ── Session Listing ──

/** `pai worker follow` panes are not sessions; list surfaces skip them. */
export function isListed(s: { workerPane?: boolean }): boolean {
  return !s.workerPane;
}

export function listClaudeSessions(): Array<{ id: string; name: string }> {
  const sessions = snapshotAllSessions().filter(isListed);
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

  return snapshots.filter(isListed).map((s) => {
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
  // Guard the write, inside the SAME AppleScript call that resolves the
  // target session — not as a separate check beforehand, which would leave a
  // window between "looks safe" and "type it" for the target to start running
  // something in. `create tab`/`create window` normally hand back a session
  // that has never run anything, so this should be a no-op in the common
  // case; it exists for the uncommon one, where tab creation silently reuses
  // or fails to isolate a session that is already running Claude — the
  // "typed a launch command into a live Claude pane" failure. `is at shell
  // prompt` is iTerm's own foreground-process check, the same primitive
  // isClaudeRunningInSession() uses elsewhere to decide it is unsafe to write.
  // A brand-new tab's shell has not sourced its shell-integration hook yet —
  // measured 2026-09-23: `is at shell prompt` reads busy for up to ~1s after
  // `create tab` on this machine, settling to true around 0.8s. A guard that
  // checked immediately would refuse every launch, not just the unsafe ones.
  // A session that is genuinely occupied (Claude or anything else) never
  // settles to shell-prompt no matter how long this waits, which is exactly
  // what keeps the guard meaningful after the delay.
  // JXA: `app` is bound to the real iTerm process by runItermJxa.
  const cmd = JSON.stringify(command);
  const write = command
    ? `ObjC.import("Foundation");
    $.NSThread.sleepForTimeInterval(1.5);
    if (!session.isAtShellPrompt()) return "busy:" + session.id();
    session.write({ text: ${cmd} });`
    : "";
  return `  var session = null;
  var targetWindow = null;
  try { targetWindow = app.currentWindow(); targetWindow.id(); } catch (e) { targetWindow = null; }
  if (!targetWindow) {
    var all = app.windows();
    if (all.length > 0) targetWindow = all[0];
  }
  var newTab = null;
  if (targetWindow) {
    try { newTab = targetWindow.createTabWithDefaultProfile(); } catch (e) { newTab = null; }
  }
  if (newTab) {
    session = newTab.currentSession();
  } else {
    var created = app.createWindowWithDefaultProfile();
    if (!created) throw new Error("iTerm2 would not create a window");
    session = created.currentSession();
  }
  ${write}
  return session.id();`;
}

/** A launch write refused because the target turned out not to be a fresh shell. */
function rejectIfBusy(result: string | null, label: string): string | null {
  if (result && result.startsWith("busy:")) {
    log(
      `${label}: refused to write into session ${result.slice(5)} — it is not at a shell prompt ` +
      `(Claude or another program is running there), so nothing was typed.`,
    );
    return null;
  }
  return result;
}

export function createClaudeSession(command = "claude"): string | null {
  try {
    return rejectIfBusy(_internal.runItermJxa(openSessionScript(command)) ?? null, "createClaudeSession");
  } catch (err) {
    log("Failed to create session:", String(err));
    return null;
  }
}

export function createTerminalTab(command?: string): string | null {
  try {
    return rejectIfBusy(_internal.runItermJxa(openSessionScript(command ?? "")) ?? null, "createTerminalTab");
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
  runItermJxa(withSessionJxa(itermSessionId, `          aSession.close();\n          return "ok";`));
}
