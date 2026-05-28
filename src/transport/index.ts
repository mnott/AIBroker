/**
 * transport/index.ts — Transport selection.
 *
 * Auto-detects the right host, with an explicit override for headless/ambiguous
 * setups (e.g. tmux nested inside iTerm, where env alone would guess wrong).
 *
 *   AIBROKER_TRANSPORT=tmux|iterm   → force a specific transport
 *   else $TMUX set + tmux server up → tmux  (you're inside tmux)
 *   else TERM_PROGRAM=iTerm.app      → iterm
 *   else tmux server up              → tmux  (headless / SSH)
 *   else                             → iterm (legacy default)
 */

import { log } from "../core/log.js";
import { ItermTransport } from "./iterm.js";
import { TmuxTransport } from "./tmux.js";
import type { SessionTransport, TransportKind } from "./session-transport.js";

export type { ManagedSession, SendOptions, SessionTransport, TransportKind } from "./session-transport.js";
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

export function selectTransport(): SessionTransport {
  const override = (process.env.AIBROKER_TRANSPORT ?? "").trim().toLowerCase();
  if (override === "tmux" || override === "iterm") {
    log(`transport: forced via AIBROKER_TRANSPORT=${override}`);
    return build(override);
  }

  const tmux = new TmuxTransport();
  const iterm = new ItermTransport();

  if (process.env.TMUX && tmux.isAvailable()) {
    log("transport: tmux (inside $TMUX)");
    return tmux;
  }
  if (process.env.TERM_PROGRAM === "iTerm.app" && iterm.isAvailable()) {
    log("transport: iterm (TERM_PROGRAM)");
    return iterm;
  }
  if (tmux.isAvailable()) {
    log("transport: tmux (server running, headless)");
    return tmux;
  }
  log("transport: iterm (default fallback)");
  return iterm;
}
