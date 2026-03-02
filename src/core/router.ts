/**
 * core/router.ts — Message routing: message → backend dispatch.
 *
 * Routes incoming messages to the appropriate AI backend.
 * Default: SessionBackend (typeIntoSession via iTerm2).
 */

import type { Backend } from "../types/backend.js";
import { log } from "./log.js";

export class MessageRouter {
  private _defaultBackend: Backend | null = null;
  private readonly sessionBackends = new Map<string, Backend>();

  get defaultBackend(): Backend | null {
    return this._defaultBackend;
  }

  setDefaultBackend(backend: Backend): void {
    this._defaultBackend = backend;
    log(`Default backend set to: ${backend.name} (${backend.type})`);
  }

  route(sessionId: string): Backend | null {
    return this.sessionBackends.get(sessionId) ?? this._defaultBackend;
  }

  setBackend(sessionId: string, backend: Backend): void {
    this.sessionBackends.set(sessionId, backend);
    log(`Session ${sessionId} backend set to: ${backend.name}`);
  }

  removeBackend(sessionId: string): void {
    this.sessionBackends.delete(sessionId);
  }

  listBackends(): Array<{ sessionId: string; backend: string; type: string }> {
    const result: Array<{ sessionId: string; backend: string; type: string }> = [];
    for (const [sessionId, backend] of this.sessionBackends) {
      result.push({ sessionId, backend: backend.name, type: backend.type });
    }
    return result;
  }
}

/** Singleton router instance */
export const router = new MessageRouter();
