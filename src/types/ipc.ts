/**
 * IPC protocol types — shared between MCP client and watcher process.
 * Zero project-level imports.
 */

export interface IpcRequest {
  id: string;
  sessionId: string;
  itermSessionId?: string;
  /**
   * tmux pane id of the caller (e.g. "%3"), from $TMUX_PANE. Set when the caller
   * runs inside tmux. Unlike ITERM_SESSION_ID — which a tmux-hosted process
   * inherits from whatever iTerm tab first started the tmux server (a DIFFERENT
   * session) — TMUX_PANE is correct per pane, so it's the authoritative caller
   * identity for tmux sessions.
   */
  tmuxPane?: string;
  /**
   * The caller's terminal device, e.g. "/dev/ttys004".
   *
   * A second, independent answer to "which session is this?", and the one that
   * cannot go stale. `ITERM_SESSION_ID` is an environment variable: a process
   * that outlives the pane it was started in, or inherits an environment from
   * somewhere else, keeps announcing an id that no longer exists — and a name
   * written against it lands on a session nobody can see, while the real pane
   * stays anonymous. The tty is what the process is actually attached to now,
   * and iTerm reports it per session, so the two can be reconciled.
   */
  callerTty?: string;
  /**
   * The Claude Code session uuid the caller runs under, when known. A session
   * moved into a Claude background session keeps announcing the iTerm pane it
   * started in (now a shell) while the pane you see runs `claude attach`; the
   * uuid is what ties the two together for mailbox routing.
   */
  claudeSessionId?: string;
  /**
   * True when the caller's Claude process has no terminal: a background
   * session. Its inherited pane ids are not its own and are not sent.
   */
  background?: boolean;
  /** The terminal of the caller's Claude process; a pane is the caller's only if its tty equals this. */
  claudeTty?: string;
  /** The background session's own name, when its command line carries one. */
  claudeName?: string;
  method: string;
  params: Record<string, unknown>;
}

export interface IpcResponse {
  id: string;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}
