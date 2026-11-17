/**
 * transport/index.ts — Transport selection.
 *
 * Auto-detects the right host, with an explicit override for headless/ambiguous
 * setups (e.g. tmux nested inside iTerm, where env alone would guess wrong).
 *
 *   AIBROKER_TRANSPORT=tmux|iterm   → force a specific transport
 *   else not macOS                   → tmux  (no iTerm exists)
 *   else $TMUX set + tmux server up → tmux  (you're inside tmux)
 *   else TERM_PROGRAM=iTerm.app      → iterm
 *   else tmux server up              → tmux  (headless / SSH)
 *   else                             → iterm (legacy default)
 */

import { log } from "../core/log.js";
import { ItermTransport } from "./iterm.js";
import { TmuxTransport } from "./tmux.js";
import type { SessionTransport, TransportKind } from "./session-transport.js";
import { itermInPlay } from "./policy.js";

export type { LaunchOptions, LaunchResult, ManagedSession, SendOptions, SessionTransport, TransportKind } from "./session-transport.js";
export { ItermTransport } from "./iterm.js";
export { TmuxTransport } from "./tmux.js";

function build(kind: TransportKind): SessionTransport {
  switch (kind) {
    case "tmux":
      return new TmuxTransport();
    case "iterm":
      return new ItermTransport();
    case "pty":
      throw new Error("pty transport not implemented yet");
  }
}

/**
 * Pick a host WITHOUT probing: the env override and the deterministic rules.
 * Availability probes are async now — a sync iTerm probe (`osascript`) on a
 * wedged iTerm would block whatever selected, so callers that need a probed
 * choice await selectTransportAsync(); this stays the cheap path and defaults
 * to iterm exactly as before when nothing is decided earlier.
 */
export function selectTransport(): SessionTransport {
  const override = (process.env.AIBROKER_TRANSPORT ?? "").trim().toLowerCase();
  if (override === "tmux" || override === "iterm") {
    log(`transport: forced via AIBROKER_TRANSPORT=${override}`);
    return build(override);
  }

  if (!itermInPlay()) {
    log(`transport: tmux (${process.platform}, no iTerm)`);
    return build("tmux");
  }

  // Inside a tmux client, tmux is the host whether or not we can probe it here.
  if (process.env.TMUX) {
    log("transport: tmux (inside $TMUX)");
    return build("tmux");
  }
  return build("iterm");
}

/** selectTransport with live availability probes, all async. */
export async function selectTransportAsync(): Promise<SessionTransport> {
  const override = (process.env.AIBROKER_TRANSPORT ?? "").trim().toLowerCase();
  if (override === "tmux" || override === "iterm") return build(override);
  if (!itermInPlay()) return build("tmux");

  const tmux = new TmuxTransport();
  const iterm = new ItermTransport();

  if (process.env.TMUX && await tmux.isAvailable()) {
    log("transport: tmux (inside $TMUX)");
    return tmux;
  }
  if (process.env.TERM_PROGRAM === "iTerm.app" && await iterm.isAvailable()) {
    log("transport: iterm (TERM_PROGRAM)");
    return iterm;
  }
  if (await tmux.isAvailable()) {
    log("transport: tmux (server running, headless)");
    return tmux;
  }
  log("transport: iterm (default fallback)");
  return iterm;
}
