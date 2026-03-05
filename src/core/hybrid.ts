/**
 * core/hybrid.ts — HybridSessionManager: unified API + visual session management.
 *
 * Maintains a flat, creation-ordered list of sessions that can be either:
 * - "api": headless Claude subprocess (managed by APIBackend)
 * - "visual": iTerm2 terminal tab (managed by the transport's iTerm2 adapter)
 *
 * Transports (Whazaa, Telex) use this to provide a single /s list and /N switch
 * that seamlessly mixes both session types.  Message delivery routing is based on
 * the active session's kind — the transport decides how to deliver.
 */

import type { APIBackend } from "../backend/api.js";
import { log } from "./log.js";

export type SessionKind = "api" | "visual";

export interface HybridSession {
  /** Hybrid session ID: "h-1", "h-2", ... */
  id: string;
  /** Human-readable name */
  name: string;
  /** Working directory */
  cwd: string;
  /** Session kind */
  kind: SessionKind;
  /** Creation timestamp */
  createdAt: number;
  /** Backend-specific ID: "api-N" for API sessions, iTerm2 UUID for visual */
  backendSessionId: string;
}

export class HybridSessionManager {
  readonly apiBackend: APIBackend;

  private readonly sessions: HybridSession[] = [];
  private _activeIndex = -1;
  private nextNum = 1;

  constructor(apiBackend: APIBackend) {
    this.apiBackend = apiBackend;
  }

  // ── Session creation ──

  /** Create a new headless (API) session. Delegates to APIBackend. */
  createApiSession(name: string, cwd: string): HybridSession {
    const apiSession = this.apiBackend.createSession(name, cwd);
    const session: HybridSession = {
      id: `h-${this.nextNum++}`,
      name,
      cwd,
      kind: "api",
      createdAt: Date.now(),
      backendSessionId: apiSession.id,
    };
    this.sessions.push(session);
    this._activeIndex = this.sessions.length - 1;
    // Keep APIBackend active session in sync
    this.apiBackend.activeSessionId = apiSession.id;
    log(`HybridManager: created API session "${name}" (${session.id} -> ${apiSession.id})`);
    return session;
  }

  /** Register a visual (iTerm2) session. The transport creates the tab and passes the ID. */
  registerVisualSession(name: string, cwd: string, itermSessionId: string): HybridSession {
    const session: HybridSession = {
      id: `h-${this.nextNum++}`,
      name,
      cwd,
      kind: "visual",
      createdAt: Date.now(),
      backendSessionId: itermSessionId,
    };
    this.sessions.push(session);
    this._activeIndex = this.sessions.length - 1;
    log(`HybridManager: registered visual session "${name}" (${session.id} -> ${itermSessionId})`);
    return session;
  }

  // ── Navigation ──

  /** Switch to session by 1-based display index. Returns the session or undefined. */
  switchToIndex(index: number): HybridSession | undefined {
    const session = this.sessions[index - 1];
    if (!session) return undefined;
    this._activeIndex = index - 1;
    // Sync APIBackend active session when switching to an API session
    if (session.kind === "api") {
      this.apiBackend.activeSessionId = session.backendSessionId;
    }
    log(`HybridManager: switched to ${session.kind} session "${session.name}" (${session.id})`);
    return session;
  }

  /** Remove session by 1-based display index. For API sessions, also ends in APIBackend. */
  removeByIndex(index: number): HybridSession | undefined {
    const session = this.sessions[index - 1];
    if (!session) return undefined;

    // End in APIBackend if it's an API session
    if (session.kind === "api") {
      this.apiBackend.endSession(session.backendSessionId);
    }

    this.sessions.splice(index - 1, 1);

    // Adjust active index
    if (this.sessions.length === 0) {
      this._activeIndex = -1;
    } else if (this._activeIndex >= this.sessions.length) {
      this._activeIndex = this.sessions.length - 1;
    } else if (index - 1 < this._activeIndex) {
      this._activeIndex--;
    } else if (index - 1 === this._activeIndex) {
      // Was active — pick the previous, or first
      this._activeIndex = Math.min(this._activeIndex, this.sessions.length - 1);
    }

    // Re-sync APIBackend active session
    const newActive = this.activeSession;
    if (newActive?.kind === "api") {
      this.apiBackend.activeSessionId = newActive.backendSessionId;
    }

    log(`HybridManager: removed ${session.kind} session "${session.name}" (${session.id})`);
    return session;
  }

  /** Clear the active session's conversation (API only — no-op for visual). */
  clearActiveSession(): void {
    const active = this.activeSession;
    if (!active) return;
    if (active.kind === "api") {
      this.apiBackend.clearSession(active.backendSessionId);
      log(`HybridManager: cleared API session "${active.name}"`);
    }
  }

  // ── Accessors ──

  /** The currently active session, or undefined if none. */
  get activeSession(): HybridSession | undefined {
    return this._activeIndex >= 0 ? this.sessions[this._activeIndex] : undefined;
  }

  /**
   * Remove visual sessions whose iTerm2 tab no longer exists.
   * Call with the set of live iTerm2 session IDs from snapshotAllSessions().
   */
  pruneDeadVisualSessions(liveIds: Set<string>): number {
    let pruned = 0;
    for (let i = this.sessions.length - 1; i >= 0; i--) {
      const s = this.sessions[i];
      if (s.kind === "visual" && !liveIds.has(s.backendSessionId)) {
        this.sessions.splice(i, 1);
        pruned++;
        log(`HybridManager: pruned dead visual session "${s.name}" (${s.backendSessionId.slice(0, 8)}...)`);
        // Adjust active index
        if (i < this._activeIndex) {
          this._activeIndex--;
        } else if (i === this._activeIndex) {
          this._activeIndex = Math.min(this._activeIndex, this.sessions.length - 1);
        }
      }
    }
    if (this.sessions.length === 0) this._activeIndex = -1;
    return pruned;
  }

  /** All sessions in creation order. */
  listSessions(): HybridSession[] {
    return [...this.sessions];
  }

  /** Get session by 1-based display index. */
  getByIndex(index: number): HybridSession | undefined {
    return this.sessions[index - 1];
  }

  // ── Display ──

  /** Format the unified session list for display. */
  formatSessionList(): string {
    if (this.sessions.length === 0) return "No sessions.";
    return this.sessions.map((s, i) => {
      const isActive = i === this._activeIndex;
      const tag = s.kind === "api" ? "[api]" : "[visual]";
      const marker = isActive ? "*" : " ";
      return `${marker}${i + 1}. ${s.name} ${tag} (${s.cwd})`;
    }).join("\n");
  }

  /**
   * Get a status string for the active session.
   * Returns formatted text for API sessions, null for visual sessions
   * (signals transport to take a screenshot instead).
   */
  formatActiveStatus(): string | null {
    const active = this.activeSession;
    if (!active) return "No active session.";
    if (active.kind === "api") {
      return this.apiBackend.formatStatus();
    }
    // Visual session — transport should take a screenshot
    return null;
  }
}

/** Singleton hybrid manager (set at startup by transport's watch()). */
export let hybridManager: HybridSessionManager | null = null;

export function setHybridManager(m: HybridSessionManager | null): void {
  hybridManager = m;
}
