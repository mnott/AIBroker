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
import { aibrokerIdForPane } from "../transport/sync-facade.js";
import { loadPeering, rejectWildcard, tokenMatches } from "./peering.js";

export type IpcHandler = (
  req: IpcRequest,
) => Promise<{ ok: true; result: Record<string, unknown> } | { ok: false; error: string }>;

export class IpcServer {
  private server: Server | null = null;
  /**
   * The peer listener, if peering is configured. A second server object rather
   * than a second address on the first, because the two have different trust:
   * the unix socket is protected by file permissions and everything on it is
   * already local, while this one must authenticate every request.
   */
  private peerServer: Server | null = null;
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

    this.startPeerListener();
  }

  /**
   * The cross-machine door. Closed unless somebody configured it.
   *
   * Everything that makes this safe is here rather than spread out: no default
   * port, no wildcard bind, and a secret checked on every single request before
   * the method is even looked up. A caller that reached the port has proved
   * nothing except that it reached the port.
   */
  private startPeerListener(): void {
    let cfg;
    try {
      cfg = loadPeering().listen;
    } catch {
      return;
    }
    if (!cfg?.port || !cfg.host || !cfg.token) return;

    const refusal = rejectWildcard(cfg.host);
    if (refusal) {
      log(`[peer] NOT listening: ${refusal}`);
      return;
    }

    this.peerServer = createServer((socket: Socket) => {
      let buffer = "";
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const nl = buffer.indexOf("\n");
        if (nl === -1) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);

        const deny = (error: string) => {
          socket.write(JSON.stringify({ id: "unknown", ok: false, error } satisfies IpcResponse) + "\n");
          socket.end();
        };

        let req: IpcRequest & { peerToken?: unknown };
        try {
          req = JSON.parse(line);
        } catch {
          return deny("Invalid JSON");
        }

        // Authenticate BEFORE dispatch, and say as little as possible about why.
        // A caller learning which half of the credential was wrong is a caller
        // being helped to guess.
        if (!tokenMatches(req.peerToken, cfg.token)) {
          log(`[peer] rejected an unauthenticated request from ${socket.remoteAddress ?? "?"}`);
          return deny("not paired with this hub");
        }

        this.dispatch(req)
          .then((resp) => { socket.write(JSON.stringify(resp) + "\n"); socket.end(); })
          .catch((err) => {
            socket.write(JSON.stringify({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) }) + "\n");
            socket.end();
          });
      });
      socket.on("error", () => { /* a peer that hangs up is not an event */ });
    });

    this.peerServer.listen(cfg.port, cfg.host, () => {
      log(`[peer] listening on ${cfg.host}:${cfg.port} — paired hubs only`);
    });
    this.peerServer.on("error", (err) => {
      log(`[peer] listener error: ${err}`);
    });
  }

  /**
   * Stop the IPC server.
   */
  stop(): void {
    this.server?.close();
    this.peerServer?.close();
    if (existsSync(this.socketPath)) {
      try { unlinkSync(this.socketPath); } catch { /* ignore */ }
    }
  }

  private async dispatch(req: IpcRequest): Promise<IpcResponse> {
    // A tmux-hosted caller's ITERM_SESSION_ID is the stale id of the iTerm tab
    // that started the tmux server (a different session). Identify the caller by
    // its durable @aibroker_id (resolved from the pane) — which is exactly what
    // session snapshots now use as the id for tmux sessions — so mailbox drain,
    // sender label, and response routing all target the right, stable session and
    // never collide with a later session that reuses the same pane id.
    if (req.tmuxPane) req.itermSessionId = aibrokerIdForPane(req.tmuxPane) ?? req.tmuxPane;

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
