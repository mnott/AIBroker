/**
 * transport/sync-facade.ts — Drop-in replacements for the iTerm primitives,
 * with MULTI-TRANSPORT enumeration.
 *
 * The daemon historically imported `snapshotAllSessions`, `typeIntoSession`,
 * `pasteTextIntoSession`, and `isClaudeRunningInSession` directly from
 * adapters/iterm/core.ts. Those imports are repointed here. Every function keeps
 * the EXACT same signature.
 *
 * Transport selection (decided once at module load):
 *   AIBROKER_TRANSPORT=iterm  → iTerm only
 *   AIBROKER_TRANSPORT=tmux   → tmux only
 *   AIBROKER_TRANSPORT=multi  → both (subject to availability)
 *   unset / anything else     → AUTO: enumerate whatever is available right now
 *
 * AUTO is the default and is safe: on a Mac with no tmux server it resolves to
 * iTerm-only (byte-identical to the pre-transport behaviour — verified). The
 * instant a tmux server exists, its panes merge into the same session list, so
 * iTerm and tmux sessions show up together. This is what makes the iTerm→tmux
 * migration seamless and unblocks PAILot seeing both worlds at once.
 *
 * The iTerm path calls core.ts VERBATIM (raw SessionSnapshot: name=process name,
 * tabTitle separate, paiName=null) so every downstream consumer — gateway
 * displayName resolution, atPrompt heuristics, name matching — is unchanged.
 *
 * Per-id ops (send / busy) route by id shape: tmux pane ids start with "%",
 * iTerm uses GUIDs. With one transport active, everything routes to it.
 */

import * as iterm from "../adapters/iterm/core.js";
import type { SessionSnapshot } from "../adapters/iterm/core.js";
import { ItermTransport } from "./iterm.js";
import { TmuxTransport } from "./tmux.js";
import type { ManagedSession } from "./session-transport.js";
import { isClaudeReady } from "./screen.js";
import { audit } from "../daemon/audit.js";
import { log } from "../core/log.js";

const override = (process.env.AIBROKER_TRANSPORT ?? "").trim().toLowerCase();

const tmuxTransport = new TmuxTransport();
const itermTransport = new ItermTransport();

// Override GATES which transports are permitted; availability is then checked
// LIVE on every enumeration (NOT frozen at boot), so a tmux server started after
// the daemon launched is picked up immediately — no restart required. Likewise,
// iTerm yields nothing on a headless box (osascript absent), so AUTO degrades
// cleanly to tmux-only there.
const allowIterm = override !== "tmux";
const allowTmux = override !== "iterm";

function tmuxToSnapshot(s: ManagedSession): SessionSnapshot {
  return {
    id: s.id,
    name: s.name,
    profileName: "Default",
    tabTitle: s.tabTitle,
    tty: s.tty ?? "",
    atPrompt: !s.busy,
    // paiName merged from the persistent store by callers, exactly as for iTerm.
    paiName: null,
    // Durable id so persistent-name lookups survive %N churn across tmux restarts.
    aibrokerId: s.aibrokerId,
  };
}

/** Enumerate sessions across all permitted transports, availability checked live. */
export function snapshotAllSessions(): SessionSnapshot[] {
  // Query tmux first (returns [] if no server is running). This is the LIVE
  // availability check — a server that appears post-boot is seen immediately.
  const tmuxSessions = allowTmux ? tmuxTransport.listSessions() : [];
  let itermSessions: SessionSnapshot[] = allowIterm ? iterm.snapshotAllSessions() : [];

  if (allowIterm && tmuxSessions.length) {
    // De-dup nesting: an iTerm/Terminal tab running `tmux attach` is just a
    // VIEWER of tmux panes we already enumerate directly. Suppress those rows
    // so a tmux-hosted session appears once (as the tmux pane), not twice.
    // The link is the tty: a tmux client's tty IS the hosting tab's tty.
    const viewerTtys = tmuxTransport.attachedClientTtys();
    if (viewerTtys.size) itermSessions = itermSessions.filter((s) => !s.tty || !viewerTtys.has(s.tty));
  }

  return [...itermSessions, ...tmuxSessions.map(tmuxToSnapshot)];
}

/**
 * Decide whether an id belongs to tmux. tmux session ids are now durable
 * @aibroker_ids (a raw "%N" pane id may also appear during inbound translation).
 * A "%N" is unambiguously tmux; otherwise check whether a live tmux pane carries
 * that @aibroker_id (iTerm GUIDs won't match → routed to iTerm).
 */
function routeToTmux(id: string): boolean {
  if (!allowTmux) return false;
  if (!allowIterm) return true; // tmux is the only permitted transport
  if (id.startsWith("%")) return true;
  return tmuxTransport.paneFor(id) != null;
}

/** Translate a caller's $TMUX_PANE into the durable @aibroker_id identity. */
export function aibrokerIdForPane(paneId: string): string | null {
  if (!allowTmux) return null;
  return tmuxTransport.aibrokerIdForPane(paneId);
}

/**
 * ── Shell-injection guard ───────────────────────────────────────────────────
 *
 * A session whose Claude has exited — crashed, suspended, or ended cleanly via
 * `pai end` — leaves its tab alive at a shell prompt, keeps its persistent PAI
 * name, and therefore still matches by project. Writing to it no longer reaches
 * Claude: it reaches zsh, and zsh EXECUTES what it is sent.
 *
 * Reproduced twice for real. A probe question ran as a command; separately, an
 * ordinary status message containing a fenced code block had its example
 * command executed, creating a live Todoist task. The payload does not need to
 * be adversarial — routine technical writing is full of backticks, which zsh
 * expands as command substitution.
 *
 * The guard belongs here rather than in each caller: send_to_session, inbound
 * WhatsApp/Telegram delivery, the session backend and PAILot chunk writes all
 * carry arbitrary text into a session, and enumerating them is exactly how one
 * gets missed. Callers that legitimately address a shell — launching a session
 * types `cd … && claude …` into a fresh tab — pass `allowShell`.
 */
const READY_TTL_MS = 2_000;
const readyCache = new Map<string, { at: number; ready: boolean }>();

/** Is this session showing a live Claude prompt? Cached briefly for chunked writes. */
function claudeHasTty(id: string): boolean {
  const hit = readyCache.get(id);
  const now = Date.now();
  if (hit && now - hit.at < READY_TTL_MS) return hit.ready;

  const frame = captureSession(id, 80);
  // Unreadable is NOT treated as safe: refusing a legitimate send is recoverable,
  // executing a message in a shell is not.
  const ready = frame !== null && isClaudeReady(frame);
  readyCache.set(id, { at: now, ready });
  return ready;
}

function refuse(id: string, text: string): false {
  log(
    `REFUSED write to ${id}: no live Claude prompt — its terminal is at a shell, ` +
    `which would execute the text rather than read it. ` +
    `First 60 chars: ${JSON.stringify(text.slice(0, 60))}`,
  );
  // Also record it. A refusal here is the single most safety-relevant thing
  // this process does, and until now it only reached a log nobody tails —
  // which makes it indistinguishable from never having happened. Only the
  // send_to_session path audited its own refusals; every other caller
  // (inbound WhatsApp/Telegram delivery, the session backend, PAILot chunk
  // writes) went through here and left no trace in the trail at all.
  audit({
    action: "refuse", actor: "aibroker:transport", target: id,
    outcome: "refused", body: text,
    reason: "target terminal is a shell, not a live Claude prompt — a shell would execute this",
  });
  return false;
}

/** Inject text + Enter into a session. Refuses a shell unless `allowShell`. */
export function typeIntoSession(id: string, text: string, opts: { allowShell?: boolean } = {}): boolean {
  if (!opts.allowShell && !claudeHasTty(id)) return refuse(id, text);
  if (routeToTmux(id)) return tmuxTransport.sendText(id, text, { enter: true });
  return iterm.typeIntoSession(id, text);
}

/** Inject text WITHOUT Enter (chunked / partial sends). Same guard. */
export function pasteTextIntoSession(id: string, text: string, opts: { allowShell?: boolean } = {}): boolean {
  if (!opts.allowShell && !claudeHasTty(id)) return refuse(id, text);
  if (routeToTmux(id)) return tmuxTransport.sendText(id, text, { enter: false });
  return iterm.pasteTextIntoSession(id, text);
}

/** Drop a cached readiness verdict (call right after launching into a tab). */
export function invalidateReadyCache(id?: string): void {
  if (id) readyCache.delete(id); else readyCache.clear();
}

/** True when the session is currently showing a live Claude prompt. */
export function isClaudeSession(id: string): boolean {
  return claudeHasTty(id);
}

/**
 * Read what a session is currently showing. Used by checkpoint's ack detection,
 * which watches for the screen to change (message landed) and then settle
 * (Claude finished). Returns null when the session can't be read.
 */
export function captureSession(id: string, lines?: number): string | null {
  if (routeToTmux(id)) return tmuxTransport.capture(id, lines);
  return itermTransport.capture(id);
}

/** True when a foreground program (Claude) is running, not at a shell prompt. */
export function isClaudeRunningInSession(id: string): boolean {
  if (routeToTmux(id)) return tmuxTransport.isBusy(id);
  return iterm.isClaudeRunningInSession(id);
}

/**
 * Set a tmux pane's title. Returns false for non-tmux ids — iTerm visuals are
 * set separately by the caller via the iTerm sessions adapter.
 */
export function setSessionTitle(id: string, title: string): boolean {
  if (routeToTmux(id)) return tmuxTransport.setTitle(id, title);
  return false;
}

/**
 * For a tmux pane id, return the iTerm2 session id of the tab currently viewing
 * it (via the tmux client tty → iTerm tty match), or null if detached / not on
 * iTerm. Uses the RAW iTerm enumeration (not the de-duped facade list, which
 * suppresses viewer tabs) so the host tab can still receive iTerm visuals.
 */
export function itermViewerSessionId(tmuxPaneId: string): string | null {
  if (!allowTmux || !allowIterm) return null;
  const tty = tmuxTransport.clientTtyForPane(tmuxPaneId);
  if (!tty) return null;
  return iterm.snapshotAllSessions().find((s) => s.tty === tty)?.id ?? null;
}

log(`sync-facade: transports permitted = [${[allowIterm ? "iterm" : null, allowTmux ? "tmux" : null].filter(Boolean).join(", ")}] (availability checked live per enumeration)`);
