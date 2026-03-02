/**
 * ipc/server.ts — Unix Domain Socket IPC server.
 *
 * Creates the UDS, parses NDJSON requests, and delegates to a handler map.
 * Transport-specific handlers are registered by the per-project watcher.
 */

import { createServer, Server, Socket } from "node:net";
import { existsSync, unlinkSync } from "node:fs";

import type { IpcRequest, IpcResponse } from "../types/ipc.js";
import { log } from "../core/log.js";
import { sessionRegistry, clientQueues } from "../core/state.js";

export type IpcHandler = (
  req: IpcRequest,
) => Promise<{ ok: true; result: Record<string, unknown> } | { ok: false; error: string }>;

export class IpcServer {
  private server: Server | null = null;
  private readonly handlers = new Map<string, IpcHandler>();
  private readonly socketPath: string;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  /**
   * Register a handler for an IPC method.
   */
  on(method: string, handler: IpcHandler): void {
    this.handlers.set(method, handler);
  }

  /**
   * Start listening on the Unix Domain Socket.
   */
  start(): void {
    // Clean up stale socket
    if (existsSync(this.socketPath)) {
      try { unlinkSync(this.socketPath); } catch { /* ignore */ }
    }

    this.server = createServer((socket: Socket) => {
      let buffer = "";

      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const nl = buffer.indexOf("\n");
        if (nl === -1) return;

        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);

        let req: IpcRequest;
        try {
          req = JSON.parse(line) as IpcRequest;
        } catch {
          const errResp: IpcResponse = { id: "unknown", ok: false, error: "Invalid JSON" };
          socket.write(JSON.stringify(errResp) + "\n");
          socket.end();
          return;
        }

        this.dispatch(req).then((resp) => {
          socket.write(JSON.stringify(resp) + "\n");
          socket.end();
        }).catch((err) => {
          const errResp: IpcResponse = {
            id: req.id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
          socket.write(JSON.stringify(errResp) + "\n");
          socket.end();
        });
      });

      socket.on("error", () => { /* ignore client disconnect */ });
    });

    this.server.listen(this.socketPath, () => {
      log(`IPC server listening on ${this.socketPath}`);
    });

    this.server.on("error", (err) => {
      log(`IPC server error: ${err}`);
    });
  }

  /**
   * Stop the IPC server.
   */
  stop(): void {
    this.server?.close();
    if (existsSync(this.socketPath)) {
      try { unlinkSync(this.socketPath); } catch { /* ignore */ }
    }
  }

  private async dispatch(req: IpcRequest): Promise<IpcResponse> {
    // Auto-register unknown sessions
    if (req.method !== "register" && !sessionRegistry.has(req.sessionId)) {
      sessionRegistry.set(req.sessionId, {
        sessionId: req.sessionId,
        name: "Auto-registered",
        itermSessionId: req.itermSessionId,
        registeredAt: Date.now(),
      });
      if (!clientQueues.has(req.sessionId)) {
        clientQueues.set(req.sessionId, []);
      }
    }

    const handler = this.handlers.get(req.method);
    if (!handler) {
      return { id: req.id, ok: false, error: `Unknown method: ${req.method}` };
    }

    try {
      const result = await handler(req);
      if (result.ok) {
        return { id: req.id, ok: true, result: result.result };
      } else {
        return { id: req.id, ok: false, error: result.error };
      }
    } catch (err) {
      return {
        id: req.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
