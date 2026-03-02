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
