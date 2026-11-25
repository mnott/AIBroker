/**
 * adapters/iterm/sessions.ts — Higher-level iTerm2 session management.
 *
 * Session variables, tab naming, discovery, creation, and lifecycle.
 * Does NOT import any transport send functions — callers handle message delivery.
 */

import { execFile } from "node:child_process";
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
  liveSessionFor,
  claudeSessionOfId,
} from "../../core/state.js";
import { saveSessionRegistry, getAllPersistentSessionNames, lookupPersistentName, setPersistentSessionName, removePersistentSessionName } from "../../core/persistence.js";

// ── Session Variable Helpers ──

async function setItermSessionProperty(itermSessionId: string, body: string): Promise<void> {
  if (!itermInPlay()) return;
  await runItermJxa(withSessionJxa(itermSessionId, `          ${body}\n          return "ok";`), 5_000);
}

export async function setItermSessionVar(itermSessionId: string, name: string): Promise<void> {
  const value = JSON.stringify(name.replace(/[\n\r]/g, " "));
  await setItermSessionProperty(itermSessionId, `aSession.setVariable({ named: "user.paiName", to: ${value} });`);
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

export async function setItermBadge(itermSessionId: string, text: string): Promise<void> {
  if (!itermInPlay()) return;
  // Write badge escape sequence to the session's tty device.
  // Must go to terminal output stream (not stdin via "write text").
  try {
    const tty = ((await runItermJxa(
      withSessionJxa(itermSessionId, `          return aSession.tty();`),
      5_000,
    )) ?? "").trim();
    if (!tty || !tty.startsWith("/dev/ttys")) return;
    const b64 = Buffer.from(text).toString("base64");
    // Awaited child instead of execSync (which blocked the event loop up to 3 s
    // per badge). Same command as before — bash's printf builtin redirected to
    // the tty — but the payload and path travel as ARGV, never interpolated
    // into shell syntax. The tty is validated above to ^/dev/ttys[A-Za-z0-9]+$;
    // the base64 alphabet carries no shell characters.
    await new Promise<void>((resolve) => {
      execFile(
        "/bin/bash",
        ["-c", 'tty=$1; shift; printf \'\\033]1337;SetBadgeFormat=%s\\007\' "$@" > "$tty"', "bash", tty, b64],
        { timeout: 3_000 },
        () => resolve(),
      );
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
export async function revealItermSession(itermSessionId: string): Promise<boolean> {
  if (!itermInPlay()) return false;
  try {
    const result = await runItermJxa(withSessionJxa(
      itermSessionId,
      `          aWindow.select(); aTab.select(); aSession.select(); app.activate();\n          return "ok";`,
      '"no"',
    ), 5_000);
    return result === "ok";
  } catch {
    return false;
  }
}

export async function getItermSessionVar(itermSessionId: string): Promise<string | null> {
  if (!itermInPlay()) return null;
  const result = await runItermJxa(withSessionJxa(
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
 * A name stored under a dead pane id follows its Claude session to the
 * `claude attach` pane now serving it (killed and reattached keeps its name),
 * unless that pane already has a name of its own. Returns how many moved.
 */
export async function moveStaleNamesToAttachPanes(sessions: SessionSnapshot[]): Promise<number> {
  const live = new Set(sessions.map((s) => s.id));
  let moved = 0;
  for (const [id, name] of Object.entries(getAllPersistentSessionNames())) {
    if (live.has(id) || !claudeSessionOfId(id)) continue;
    const target = liveSessionFor(id, sessions);
    if (target === id || lookupPersistentName(getAllPersistentSessionNames(), target)) continue;
    removePersistentSessionName(id);
    if (!(await setPersistentSessionName(target, name)).ok) continue;
    log(`Name authority: moved "${name}" from dead pane ${id.slice(0, 8)} to attach pane ${target.slice(0, 8)}`);
    moved += 1;
  }
  return moved;
}

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
export async function reassertPersistentTitles(
  deps: {
    sessions?: SessionSnapshot[];
    setTabName?: (id: string, name: string) => void | Promise<void>;
    setSessionVar?: (id: string, name: string) => void | Promise<void>;
    setBadge?: (id: string, name: string) => void | Promise<void>;
    setPaneTitle?: (id: string, name: string) => boolean | Promise<boolean>;
    viewerFor?: (paneId: string) => string | null | Promise<string | null>;
  } = {},
): Promise<number> {
  const setTabName = deps.setTabName ?? setItermTabName;
  const setSessionVar = deps.setSessionVar ?? setItermSessionVar;
  const setBadge = deps.setBadge ?? setItermBadge;
  const setPaneTitle = deps.setPaneTitle ?? setSessionTitle;
  const viewerFor = deps.viewerFor ?? itermViewerSessionId;
  const sessions = deps.sessions ?? (await snapshotAllTransports());
  await moveStaleNamesToAttachPanes(sessions);

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
      await setPaneTitle(s.id, chosen);
      const viewer = await viewerFor(s.id);
      if (viewer) {
        await setSessionVar(viewer, chosen);
        await setTabName(viewer, chosen);
        await setBadge(viewer, chosen);
      }
    } else {
      await setSessionVar(s.id, chosen);
      await setTabName(s.id, chosen);
      await setBadge(s.id, chosen);
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

export async function findItermSessionForTermId(
  termSessionId: string,
  itermSessionIdHint?: string,
): Promise<string | null> {
  if (itermSessionIdHint) {
    return stripItermPrefix(itermSessionIdHint) ?? itermSessionIdHint;
  }

  const script = `  var wanted = ${JSON.stringify(termSessionId)};
  var found = "";
  eachSession(function (s) {
    if (found) return;
    var v = "";
    try { v = s.variable({ named: "TERM_SESSION_ID" }); } catch (e) {}
    if (v === wanted) found = s.id();
  });
  return found;`;

  const result = await runItermJxa(script);
  return (result && result.length > 0) ? result : null;
}


// ── Session Listing ──

/** `pai worker follow` panes are not sessions; list surfaces skip them. */
export function isListed(s: { workerPane?: boolean }): boolean {
  return !s.workerPane;
}

export async function listClaudeSessions(): Promise<Array<{ id: string; name: string }>> {
  const sessions = (await snapshotAllSessions()).filter(isListed);
  const persistentNames = getAllPersistentSessionNames();
  return sessions
    .filter((s) => s.name.toLowerCase().includes("claude") || lookupPersistentName(persistentNames, s.id, s.aibrokerId))
    .map((s) => ({ id: s.id, name: lookupPersistentName(persistentNames, s.id, s.aibrokerId) ?? s.name }));
}

/**
 * Build a full session list with type classification and PAI name resolution.
 * Returns the data used by /s command.
 */
export async function getSessionList(): Promise<Array<{
  id: string;
  name: string;
  path: string;
  type: "claude" | "terminal";
  paiName: string | null;
  atPrompt: boolean;
}>> {
  const snapshots = await snapshotAllSessions();
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
    if (!session.isAtShellPrompt()) {
      // Close what THIS call opened, so a refused launch leaves no stray tab;
      // a session that already existed (reused tab) is never touched.
      var sid = session.id();
      if (!before[sid]) { try { session.close(); } catch (e) {} }
      return "busy:" + sid;
    }
    // Operator keystrokes typed during the settle wait land in the new tab's
    // input line; Ctrl-U (kill whole line) first, so the command stands alone.
    session.write({ text: "\\u0015", newline: false });
    session.write({ text: ${cmd} });`
    : "";
  return `  var session = null;
  var before = {};
  eachSession(function (s) { before[s.id()] = true; });
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

export async function createClaudeSession(command = "claude"): Promise<string | null> {
  try {
    return rejectIfBusy((await _internal.runItermJxa(openSessionScript(command))) ?? null, "createClaudeSession");
  } catch (err) {
    log("Failed to create session:", String(err));
    return null;
  }
}

export async function createTerminalTab(command?: string): Promise<string | null> {
  try {
    return rejectIfBusy((await _internal.runItermJxa(openSessionScript(command ?? ""))) ?? null, "createTerminalTab");
  } catch (err) {
    log("Failed to create terminal tab:", String(err));
    return null;
  }
}

// ── Session Lifecycle ──

export async function restartSession(itermSessionId: string, command = "claude"): Promise<void> {
  await sendKeystrokeToSession(itermSessionId, 3); // Ctrl+C
  await new Promise((r) => setTimeout(r, 500));
  // Uses the RAW core primitive, not the guarded facade, deliberately:
  // addressing a shell is the whole point here — Ctrl+C has just dropped this
  // tab out of Claude so the launch command can be typed into it.
  await typeIntoSession(itermSessionId, command);
}

export async function killSession(itermSessionId: string): Promise<void> {
  await runItermJxa(withSessionJxa(itermSessionId, `          aSession.close();\n          return "ok";`));
}
