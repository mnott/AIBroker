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
  method: string;
  params: Record<string, unknown>;
}

export interface IpcResponse {
  id: string;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}
