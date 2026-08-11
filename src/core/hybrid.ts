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
import { activeItermSessionId } from "./state.js";

/**
 * How long one enumeration is reused for.
 *
 * Short enough that no answer a person reads is meaningfully out of date;
 * long enough that a client reconnect storm cannot turn a blocking terminal
 * query into the daemon's whole capacity.
 */
const SYNC_COALESCE_MS = 3_000;

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
  private discover?: () => Array<{ id: string; name: string; paiName?: string | null; tabTitle?: string | null }>;
  /** True when the last attempt to look could not complete, so the list is last-known. */
  private lastDiscoveryFailed = false;
  /** When discovery last ran, so a burst of readers costs one enumeration. */
  private lastSyncAt = 0;
  private coalesceMs = SYNC_COALESCE_MS;

  constructor(apiBackend: APIBackend) {
    this.apiBackend = apiBackend;
  }

  /**
   * Where live sessions come from. Injected rather than imported so this stays
   * a registry rather than growing a dependency on a particular terminal.
   */
  setDiscovery(fn: () => Array<{ id: string; name: string; paiName?: string | null; tabTitle?: string | null }>): void {
    this.discover = fn;
  }

  /**
   * Change how long one enumeration is reused for.
   *
   * Exists so tests can assert the two properties separately: that a burst
   * costs one enumeration, and that a fresh look reflects what changed. With a
   * fixed window the second is only observable by waiting, which makes the
   * suite slow and the failure mode ambiguous.
   */
  setCoalesceWindow(ms: number): void {
    this.coalesceMs = ms;
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

  /** Update the name of a session identified by its backend ID. */
  updateName(backendSessionId: string, newName: string): void {
    const s = this.sessions.find(s => s.backendSessionId === backendSessionId);
    if (s && s.name !== newName) {
      log(`HybridManager: name sync "${s.name}" → "${newName}"`);
      s.name = newName;
    }
  }

  /**
   * All sessions in creation order, after checking what is actually running.
   *
   * For anything a person asked for. Discovery is an AppleScript round trip, so
   * this is the wrong call on a path that runs per message — use
   * `knownSessions()` there.
   */
  listSessions(): HybridSession[] {
    this.syncFromLive();
    return [...this.sessions];
  }

  /**
   * What the registry already knows, without going out to look.
   *
   * The read for hot paths: resolving a name for a push, checking that an id
   * still exists on the way through. Those run per message, and an enumeration
   * per message would put a terminal round trip in the delivery loop. Callers
   * that need certainty rather than speed should fall back to `listSessions()`
   * when this misses — cheap in the common case, correct in the rare one.
   */
  knownSessions(): HybridSession[] {
    return [...this.sessions];
  }

  /**
   * Bring the registry in line with what is actually running.
   *
   * Both read paths call this, which is the point: a caller cannot forget to
   * populate, because populating is not the caller's job. Registration by the
   * gateway and by the command that spawns a tab still works and is still
   * useful — it names a session at the moment it is created, before discovery
   * would have anything to go on — this only guarantees the floor.
   *
   * TWO FAILURES THAT ARE NOT THE SAME FACT. Discovery throwing means we could
   * not look; discovery returning nothing means we looked and there is nothing.
   * Folding them together would trade a false "none" for a false "current" —
   * a list that reads as freshly enumerated while being last-known, which is
   * the same lie as a Funnel reporting itself on while refusing connections.
   *
   * So: a throw keeps the known list AND is surfaced to the reader. An honest
   * empty prunes, because a registry that keeps dead rows after looking is
   * showing sessions that do not exist.
   */
  private syncFromLive(): void {
    if (!this.discover) return;
    // COALESCE. Discovery is a blocking AppleScript round trip — measured at
    // 1.26 s on this machine — and Node has one thread. A mobile client that
    // reconnects every two seconds asks for the list on every connect, so each
    // reconnect stalled the whole daemon for seconds: heartbeats from other
    // adapters timed out, their re-registrations queued behind the same lock,
    // and the phone's own connection dropped because nothing could service it,
    // which made it reconnect again. The hub spent fifteen seconds at a time
    // unable to answer anything.
    //
    // A short reuse window, not a cache with a lifetime: it exists to make a
    // BURST cost one enumeration, and it is deliberately shorter than a human
    // can act, so no user-visible answer is stale by more than a moment.
    const now = Date.now();
    if (now - this.lastSyncAt < this.coalesceMs) return;
    this.lastSyncAt = now;
    let live: Array<{ id: string; name: string; paiName?: string | null; tabTitle?: string | null }>;
    try {
      live = this.discover();
      this.lastDiscoveryFailed = false;
    } catch (e) {
      this.lastDiscoveryFailed = true;
      log(`HybridManager: discovery failed, keeping the known list — ${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    const liveIds = new Set(live.map((s) => s.id));
    this.pruneDeadVisualSessions(liveIds);

    const known = new Set(this.sessions.map((s) => s.backendSessionId));
    const seen = new Set<string>();
    const activeBefore = this.activeSession;
    for (const snap of live) {
      const displayName = snap.paiName ?? snap.tabTitle ?? snap.name;
      if (seen.has(displayName)) continue;
      seen.add(displayName);
      if (!known.has(snap.id)) this.registerVisualSession(displayName, "", snap.id);
    }
    // registerVisualSession moves the selection to whatever it just added.
    // Discovery is not a selection, so put it back where the user left it —
    // and on the FIRST population there is nothing to put back, which would
    // otherwise leave "active" pointing at whichever tab happened to be
    // enumerated last. Fall back to the session the hub actually considers
    // active, so this list and every other reader mark the same one.
    const restoreTo = activeBefore?.backendSessionId ?? activeItermSessionId;
    if (restoreTo) {
      const i = this.sessions.findIndex((s) => s.backendSessionId === restoreTo);
      if (i >= 0) this._activeIndex = i;
    }
  }

  /** Get session by 1-based display index. */
  getByIndex(index: number): HybridSession | undefined {
    return this.sessions[index - 1];
  }

  // ── Display ──

  /**
   * Format the unified session list for display.
   *
   * Discovers first, so "No sessions." can only ever mean there are none —
   * not that nobody had populated the registry yet. Before this, the answer
   * depended on whether a PAILot client had happened to connect since the last
   * daemon restart: ask over a channel before that and you were told the
   * machine was empty, in the same words it would use if it were.
   */
  formatSessionList(): string {
    this.syncFromLive();
    // Say which of the two it is. A reader cannot otherwise tell a machine with
    // nothing running from one we could not ask.
    if (this.sessions.length === 0) {
      return this.lastDiscoveryFailed
        ? "Could not enumerate sessions, and none were known."
        : "No sessions.";
    }
    const rows = this.sessions.map((s, i) => {
      const isActive = i === this._activeIndex;
      const tag = s.kind === "api" ? "[api]" : "[visual]";
      const marker = isActive ? "*" : " ";
      return `${marker}${i + 1}. ${s.name} ${tag}${s.cwd ? ` (${s.cwd})` : ""}`;
    });
    if (this.lastDiscoveryFailed) {
      rows.push("(could not enumerate sessions — showing last known)");
    }
    return rows.join("\n");
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
