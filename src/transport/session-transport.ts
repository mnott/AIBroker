/**
 * transport/session-transport.ts — Terminal-host abstraction.
 *
 * AIBroker controls Claude Code sessions through five primitives that were
 * historically hardcoded to iTerm2 + AppleScript. This interface lets the same
 * hub logic drive tmux (headless / Linux / SSH) or, later, a pty-owned process,
 * without the rest of the daemon knowing which host it's talking to.
 *
 * Methods are SYNCHRONOUS on purpose: the daemon's existing iTerm path already
 * blocks on `spawnSync` osascript, and the call sites (snapshot enumeration,
 * message delivery) are written synchronously across the codebase. Keeping the
 * same shape makes the iTerm→transport swap a drop-in with no async refactor.
 *
 * Zero transport-specific imports here — implementations live in sibling files.
 */

export type TransportKind = "iterm" | "tmux" | "pty";

export interface ManagedSession {
  /** Transport-stable id usable as a target for every method, e.g. "%3" (tmux) or an iTerm GUID. */
  id: string;
  /** Best human display name (already resolved: title over raw process name). */
  name: string;
  /** Explicit tab/pane title if one was set, else null. */
  tabTitle: string | null;
  /** Controlling tty path if known. */
  tty: string | null;
  /** True when a foreground program is running (NOT sitting at a shell prompt). */
  busy: boolean;
  /** Which transport this session belongs to. */
  transport: TransportKind;
  /**
   * Durable, transport-agnostic id that survives a host restart (scheme B).
   * tmux: a `@aibroker_id` pane user-option we assign. iTerm: the GUID (already stable).
   * This is the key the persistent paiName store should use across transports.
   */
  aibrokerId: string | null;
}

export interface SendOptions {
  /** Press Enter after the text (default true). */
  enter?: boolean;
  /** Confirm the text landed before pressing Enter, retrying the literal send if not (default true). */
  verify?: boolean;
  /** Max literal-send attempts when verify is on (default 3). */
  maxRetries?: number;
}

export interface SessionTransport {
  readonly kind: TransportKind;
  /** Cheap probe: is this host present/usable right now? */
  isAvailable(): boolean;
  /** Enumerate all sessions this transport can see. */
  listSessions(): ManagedSession[];
  /**
   * Inject text into a session. On tmux this is `send-keys -l` then a SEPARATE `Enter`
   * (the one-command-text / one-command-enter rule), with verify+retry because bare
   * combined sends are unreliable for Claude Code.
   */
  sendText(id: string, text: string, opts?: SendOptions): boolean;
  /** Read what the session is currently showing. `lines` includes scrollback when >visible. */
  capture(id: string, lines?: number): string | null;
  /** True when a foreground program is running (coarse: shell vs program). */
  isBusy(id: string): boolean;
  /** Set the session's title (used for the sticky paiName display). */
  setTitle(id: string, title: string): boolean;
}
