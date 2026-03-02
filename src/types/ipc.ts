/**
 * IPC protocol types — shared between MCP client and watcher process.
 * Zero project-level imports.
 */

export interface IpcRequest {
  id: string;
  sessionId: string;
  itermSessionId?: string;
  method: string;
  params: Record<string, unknown>;
}

export interface IpcResponse {
  id: string;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}
