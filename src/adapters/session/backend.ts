/**
 * adapters/session/backend.ts — SessionBackend: deliver messages via iTerm2 typeIntoSession.
 *
 * This is the primary backend for CLI-based AI models (Claude, ChatGPT, ollama).
 * Messages are typed into the terminal session and the AI responds async via
 * the transport's incoming message handler.
 */

import type { Backend, SessionBackendConfig } from "../../types/backend.js";
import { typeIntoSession } from "../iterm/core.js";
import { log } from "../../core/log.js";
import { activeItermSessionId, sessionRegistry } from "../../core/state.js";

export class SessionBackend implements Backend {
  readonly name: string;
  readonly type = "session" as const;
  readonly command: string;

  constructor(config: SessionBackendConfig & { name?: string }) {
    this.name = config.name ?? config.command;
    this.command = config.command;
  }

  /**
   * Deliver a message by typing it into the target iTerm2 session.
   * Returns undefined because the response comes back async via the transport.
   */
  async deliver(message: string, sessionId?: string): Promise<string | undefined> {
    // Resolve target iTerm2 session
    let targetItermId = activeItermSessionId;

    if (sessionId) {
      const session = sessionRegistry.get(sessionId);
      if (session?.itermSessionId) {
        targetItermId = session.itermSessionId;
      }
    }

    if (!targetItermId) {
      log(`SessionBackend: no iTerm session to deliver to`);
      return undefined;
    }

    const ok = typeIntoSession(targetItermId, message);
    if (!ok) {
      log(`SessionBackend: failed to type into session ${targetItermId}`);
    }

    return undefined; // async response via transport
  }
}
