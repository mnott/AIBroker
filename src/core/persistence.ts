/**
 * persistence.ts — Disk I/O for session registry and voice configuration.
 *
 * Parameterized by appDir (e.g. "~/.whazaa" or "~/.telex") so each
 * consumer uses its own data directory. Transport-specific store caches
 * (Baileys stores, Telegram chats) remain in per-project code.
 *
 * Both stores here load into module state at startup and save that state back,
 * which is the read -> substitute-empty -> make-it-permanent shape described at
 * the top of core/json-store.ts. They go through it: an unparseable file blocks
 * writes instead of being replaced, and every write is atomic with a `.bak`.
 */

import { join } from "node:path";
import { homedir } from "node:os";

import { log } from "./log.js";
import { GuardedStore, loadJson, saveJson } from "./json-store.js";
import {
  sessionRegistry,
  clientQueues,
  activeItermSessionId,
  setActiveItermSessionId,
  voiceConfig,
  setVoiceConfig,
} from "./state.js";
import type { VoiceConfig, SessionRegistryData } from "../types/index.js";

// ── Configuration ──

let _appDir = join(homedir(), ".aibroker");

/**
 * Set the application data directory.
 * Must be called before any load/save operations.
 */
export function setAppDir(dir: string): void {
  _appDir = dir;
  // The name store binds its path at construction, so a later dir change must
  // invalidate it or it would keep reading (and writing) the previous location.
  resetSessionNamesCache();
  // Blocks are about the files under the previous directory; the new ones have
  // not been read yet and start unblocked.
  blockedFiles.clear();
}

export function getAppDir(): string {
  return _appDir;
}

/**
 * Files that exist but could not be parsed. Writing to one would replace bytes
 * we were never able to read with the empty value we substituted for them.
 *
 * Sticky on purpose, exactly as in `GuardedStore`: both stores below load once
 * at startup into module state and then save that state back, so a single
 * unreadable read would otherwise keep truncating the file for the rest of the
 * daemon's life. A later successful read clears the block.
 */
const blockedFiles = new Set<string>();

/**
 * Read a store under the app dir. `null` for both "absent" and "unreadable" —
 * the difference is recorded in `blockedFiles`, so a caller substituting an
 * empty default cannot make that default permanent.
 */
function safeReadJson<T>(filename: string): T | null {
  const res = loadJson<T>(join(_appDir, filename));
  if (res.status === "unreadable") {
    blockedFiles.add(filename);
    return null;
  }
  blockedFiles.delete(filename);
  return res.status === "ok" ? res.data : null;
}

/** Write a store atomically, keeping a `.bak`. A no-op — loudly — when blocked. */
function safeWriteJson(filename: string, data: unknown): void {
  if (blockedFiles.has(filename)) {
    log(`persistence: NOT saving ${filename} — it was unreadable at load. ` +
        `The file is untouched; fix or remove it and restart to resume persistence.`);
    return;
  }
  try {
    saveJson(join(_appDir, filename), data);
  } catch (err) {
    log(`persistence: failed to save ${filename}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Voice Config ──

export const DEFAULT_VOICE_CONFIG: VoiceConfig = {
  defaultVoice: "bm_fable",
  voiceMode: false,
  localMode: false,
  personas: {
    Nicole: "af_nicole",
    George: "bm_george",
    Daniel: "bm_daniel",
    Fable: "bm_fable",
  },
};

export function loadVoiceConfig(): VoiceConfig {
  const data = safeReadJson<VoiceConfig>("voice-config.json");
  const merged: VoiceConfig = {
    ...DEFAULT_VOICE_CONFIG,
    ...data,
    personas: { ...DEFAULT_VOICE_CONFIG.personas, ...(data?.personas ?? {}) },
  };
  setVoiceConfig(merged);
  return merged;
}

export function saveVoiceConfig(config?: VoiceConfig): void {
  safeWriteJson("voice-config.json", config ?? voiceConfig);
}

// ── Session Registry ──

export function loadSessionRegistry(): void {
  const parsed = safeReadJson<SessionRegistryData | Array<{ sessionId: string; name: string; itermSessionId?: string }>>(
    "sessions.json",
  );
  if (!parsed) return;

  // Support both old format (plain array) and new format (object with sessions + activeItermSessionId)
  const raw: Array<{ sessionId: string; name: string; itermSessionId?: string }> =
    Array.isArray(parsed) ? parsed : (parsed.sessions ?? []);

  for (const entry of raw) {
    if (!entry.sessionId) continue;
    sessionRegistry.set(entry.sessionId, {
      sessionId: entry.sessionId,
      name: entry.name ?? "Unknown",
      itermSessionId: entry.itermSessionId,
      registeredAt: Date.now(),
    });
    if (!clientQueues.has(entry.sessionId)) {
      clientQueues.set(entry.sessionId, []);
    }
  }

  // Restore active session marker
  if (!Array.isArray(parsed) && parsed.activeItermSessionId) {
    setActiveItermSessionId(String(parsed.activeItermSessionId));
    log(`Restored active iTerm session: ${parsed.activeItermSessionId}`);
  }

  if (raw.length > 0) {
    log(`Restored ${raw.length} session(s) from disk`);
  }
}

export function saveSessionRegistry(): void {
  const data: SessionRegistryData = {
    activeItermSessionId: activeItermSessionId || "",
    sessions: Array.from(sessionRegistry.values()).map((s) => ({
      sessionId: s.sessionId,
      name: s.name,
      itermSessionId: s.itermSessionId,
    })),
  };
  safeWriteJson("sessions.json", data);
}

// ── Persistent Session Names ──
// Maps iTerm2 session UUID → user-chosen name (set via /Name command).
// Survives daemon restarts. Used to re-assert tab titles after Claude Code
// overwrites them with its auto-generated ai-title.

const SESSION_NAMES_FILE = "session-names.json";

type SessionNamesStore = Record<string, string>;

/**
 * The persistent name store.
 *
 * Guarded rather than a plain `?? {}`: this file maps every session id to its
 * PAI name, and those names are what dispatch and name-targeted sends resolve
 * against. Reading it as empty and then saving one rename over the top would
 * discard the lot, silently, on an operation that reports success — and the
 * result is cached, so a single unreadable read at startup would keep
 * truncating the file for the rest of the daemon's life.
 */
let _sessionNames: GuardedStore<SessionNamesStore> | null = null;

function sessionNames(): GuardedStore<SessionNamesStore> {
  // Built lazily: _appDir is configurable and may be set after module load.
  if (_sessionNames === null) {
    _sessionNames = new GuardedStore<SessionNamesStore>(
      join(_appDir, SESSION_NAMES_FILE),
      () => ({}),
      "session-names",
    );
  }
  return _sessionNames;
}

function loadSessionNames(): SessionNamesStore {
  return sessionNames().load();
}

function saveSessionNames(): void {
  sessionNames().save();
}

/** Drop the cached name store (used when the app dir changes, and by tests). */
export function resetSessionNamesCache(): void {
  _sessionNames = null;
}

/**
 * Persist a user-chosen name for an iTerm2 session.
 * @param itermSessionId - the raw iTerm2 session UUID (e.g. "942A4044-...")
 * @param name - the user-set name
 */
export function setPersistentSessionName(itermSessionId: string, name: string): void {
  const store = loadSessionNames();
  store[itermSessionId] = name;
  saveSessionNames();
}

/**
 * Drop names whose session no longer exists.
 *
 * This map is keyed by session id and has never been garbage-collected: on
 * 2026-08-04 it held 96 entries, most of them ids belonging to terminals closed
 * days earlier, including four separate dead ids all answering to "PAI". That
 * is not merely untidy. `lookupPersistentName` resolves by durable id as well
 * as primary id, so a stale entry is a live session's opportunity to answer to
 * the wrong name — and answering to the wrong name is how `pai <Project>`
 * reached the wrong terminal.
 *
 * `liveIds` must be the CURRENT set. The guard below is the whole safety of
 * this function: called with an empty set — iTerm not running, an enumeration
 * that failed, a daemon starting before the terminal — "no session is live"
 * reads identically to "every session ended", and pruning would erase every
 * name the user has ever assigned. So an empty set prunes nothing.
 *
 * Returns the number of entries removed, for the caller to log.
 */
export function pruneSessionNames(liveIds: Iterable<string>): number {
  const live = new Set(liveIds);
  if (live.size === 0) return 0;

  /*
   * One sighting is not enough to declare a name dead.
   *
   * The empty-set guard above catches the total failure and misses the partial
   * one, which is the case that actually happened: an enumeration returned most
   * sessions but not all, every id it did not mention was deleted, and two
   * sessions that were running the whole time lost their names permanently.
   * From the outside that looks like dispatch spawning duplicates for no
   * reason, days later, with nothing to connect it to a momentary hiccup.
   *
   * Absence has to persist to count. A miss is recorded rather than acted on,
   * and only an id missing from several consecutive enumerations is removed —
   * so a slow terminal costs a delay, never a name. Being seen clears the
   * record, because the point is CONSECUTIVE absence.
   */
  const store = loadSessionNames();
  const misses = loadPruneMisses();
  let removed = 0;

  for (const id of Object.keys(store)) {
    if (live.has(id)) {
      delete misses[id];
      continue;
    }
    misses[id] = (misses[id] ?? 0) + 1;
    if (misses[id] >= PRUNE_AFTER_CONSECUTIVE_MISSES) {
      delete store[id];
      delete misses[id];
      removed += 1;
    }
  }

  savePruneMisses(misses);
  if (removed > 0) saveSessionNames();
  return removed;
}

/**
 * How many enumerations in a row may omit an id before its name is forgotten.
 *
 * Three rather than two: two consecutive hiccups are rarer than one but not
 * rare, and the cost of waiting is a stale entry for a few minutes while the
 * cost of being wrong is a name the user chose, gone, with no way to tell that
 * is what happened.
 */
const PRUNE_AFTER_CONSECUTIVE_MISSES = 3;

/**
 * Consecutive-miss counters, beside the store rather than inside it.
 *
 * The store maps id to name and is read by other things; adding bookkeeping to
 * its values would change a published shape for the sake of a detail that only
 * this function cares about. Losing this file costs one extra grace period.
 */
function pruneMissesPath(): string {
  return join(_appDir, SESSION_NAMES_FILE.replace(/\.json$/, "-misses.json"));
}

function loadPruneMisses(): Record<string, number> {
  const r = loadJson<Record<string, number>>(pruneMissesPath());
  return r.status === "ok" ? r.data : {};
}

function savePruneMisses(misses: Record<string, number>): void {
  try {
    saveJson(pruneMissesPath(), misses, { backup: false });
  } catch {
    /* bookkeeping only: failing to record a miss costs a grace period, not a name */
  }
}

/**
 * Get the user-chosen persistent name for an iTerm2 session, or undefined.
 */
export function getPersistentSessionName(itermSessionId: string): string | undefined {
  return loadSessionNames()[itermSessionId];
}

/**
 * Get all persistent session names (for re-assert on rescan).
 */
export function getAllPersistentSessionNames(): SessionNamesStore {
  return { ...loadSessionNames() };
}

/**
 * Resolve the persistent name for a session, preferring the durable id over the
 * primary id. tmux pane ids (%N) reset on server restart, so tmux names are keyed
 * on the pane's @aibroker_id (passed as `durableId`); iTerm GUIDs are already
 * stable and pass `durableId` undefined.
 */
export function lookupPersistentName(
  names: SessionNamesStore,
  id: string,
  durableId?: string | null,
): string | null {
  if (durableId && names[durableId]) return names[durableId];
  return names[id] ?? null;
}

/**
 * Remove a persistent name when a session ends.
 */
export function removePersistentSessionName(itermSessionId: string): void {
  const store = loadSessionNames();
  delete store[itermSessionId];
  saveSessionNames();
}
