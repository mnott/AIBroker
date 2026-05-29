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
import { TmuxTransport } from "./tmux.js";
import type { ManagedSession } from "./session-transport.js";
import { log } from "../core/log.js";

const override = (process.env.AIBROKER_TRANSPORT ?? "").trim().toLowerCase();

const tmuxTransport = new TmuxTransport();

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

/** Inject text + Enter into a session. */
export function typeIntoSession(id: string, text: string): boolean {
  if (routeToTmux(id)) return tmuxTransport.sendText(id, text, { enter: true });
  return iterm.typeIntoSession(id, text);
}

/** Inject text WITHOUT Enter (chunked / partial sends). */
export function pasteTextIntoSession(id: string, text: string): boolean {
  if (routeToTmux(id)) return tmuxTransport.sendText(id, text, { enter: false });
  return iterm.pasteTextIntoSession(id, text);
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
