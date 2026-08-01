/**
 * persistence.ts — Disk I/O for session registry and voice configuration.
 *
 * Parameterized by appDir (e.g. "~/.whazaa" or "~/.telex") so each
 * consumer uses its own data directory. Transport-specific store caches
 * (Baileys stores, Telegram chats) remain in per-project code.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { log } from "./log.js";
import { GuardedStore } from "./json-store.js";
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
}

export function getAppDir(): string {
  return _appDir;
}

function ensureDir(): void {
  mkdirSync(_appDir, { recursive: true });
}

function safeReadJson<T>(filename: string): T | null {
  try {
    const path = join(_appDir, filename);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function safeWriteJson(filename: string, data: unknown): void {
  ensureDir();
  writeFileSync(join(_appDir, filename), JSON.stringify(data, null, 2), "utf-8");
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
