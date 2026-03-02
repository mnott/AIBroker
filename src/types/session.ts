/**
 * Session routing metadata for multi-client support.
 */

export interface RegisteredSession {
  sessionId: string;
  name: string;
  itermSessionId?: string;
  registeredAt: number;
}

export interface QueuedMessage {
  body: string;
  timestamp: number;
}

/**
 * Long-poll waiter callback type.
 */
export type ClientWaiter = (msgs: QueuedMessage[]) => void;

/**
 * Serialized session registry (for persistence).
 */
export interface SessionRegistryData {
  activeItermSessionId: string;
  sessions: Array<{
    sessionId: string;
    name: string;
    itermSessionId?: string;
  }>;
}
