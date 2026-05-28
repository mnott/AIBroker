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
  method: string;
  params: Record<string, unknown>;
}

export interface IpcResponse {
  id: string;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}
