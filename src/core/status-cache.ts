/**
 * core/status-cache.ts — In-memory cache for session status snapshots.
 *
 * Stores parsed summaries with content hashing for change detection.
 * Shared across all sessions — any MCP client can read/write.
 *
 * Part of Session Orchestration (Phase 1, v0.7).
 */

import { createHash } from "node:crypto";

export interface StatusSnapshot {
  sessionId: string;
  sessionName: string;
  /** When this snapshot was created */
  timestamp: number;
  /** Busy/idle state */
  state: "idle" | "busy" | "error" | "disconnected";
  /** AI-parsed 1-2 sentence summary */
  summary: string;
  /** Hash of the raw terminal content when summary was generated */
  contentHash: string;
  /** When the terminal content was last probed */
  lastProbeAt: number;
}

/** Hash terminal content for change detection */
export function hashContent(content: string): string {
  return createHash("md5").update(content).digest("hex");
}

/**
 * StatusCache — in-memory cache of parsed session summaries.
 *
 * Lives in the daemon process, shared across all MCP clients.
 */
export class StatusCache {
  private cache = new Map<string, StatusSnapshot>();

  /** Store a parsed summary for a session */
  set(sessionId: string, snapshot: StatusSnapshot): void {
    this.cache.set(sessionId, snapshot);
  }

  /** Get cached snapshot for a session */
  get(sessionId: string): StatusSnapshot | undefined {
    return this.cache.get(sessionId);
  }

  /** Get all cached snapshots */
  getAll(): StatusSnapshot[] {
    return [...this.cache.values()];
  }

  /** Check if content has changed since last probe */
  hasChanged(sessionId: string, currentContentHash: string): boolean {
    const cached = this.cache.get(sessionId);
    if (!cached) return true;
    return cached.contentHash !== currentContentHash;
  }

  /** Update just the probe timestamp (content unchanged) */
  touch(sessionId: string): void {
    const cached = this.cache.get(sessionId);
    if (cached) {
      cached.lastProbeAt = Date.now();
    }
  }

  /** Remove a session from cache */
  delete(sessionId: string): void {
    this.cache.delete(sessionId);
  }

  /** Clear entire cache */
  clear(): void {
    this.cache.clear();
  }

  /** Number of cached entries */
  get size(): number {
    return this.cache.size;
  }
}

/** Singleton cache instance for the daemon */
export const statusCache = new StatusCache();
