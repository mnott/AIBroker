/**
 * session-voice.ts — per-session voice settings.
 *
 * A session can ask to be answered in voice, pick a speaker, and set how fast
 * it speaks, without changing anyone else's defaults. Settings are keyed by
 * session name and persisted to `voice-sessions.json` under the app dir.
 *
 * Persistence goes through the same guarded pattern as persistence.ts: an
 * unparseable file blocks writes rather than being replaced with the empty
 * default we substituted for it.
 */

import { join } from "node:path";

import { log } from "../core/log.js";
import { loadJson, saveJson } from "../core/json-store.js";
import { getAppDir } from "../core/persistence.js";

export interface SessionVoiceSettings {
  replyInVoice: boolean;
  speed: number;
  voice?: string;
}

const FILENAME = "voice-sessions.json";
const MIN_SPEED = 0.5;
const MAX_SPEED = 2;
const SPEED_STEP = 0.05;

export const DEFAULT_SESSION_SETTINGS: SessionVoiceSettings = { replyInVoice: false, speed: 1.0 };

type Store = Record<string, SessionVoiceSettings>;

/** Files that exist but could not be parsed — sticky until a good read. */
const blockedFiles = new Set<string>();

function clampSpeed(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_SESSION_SETTINGS.speed;
  const clamped = Math.min(MAX_SPEED, Math.max(MIN_SPEED, v));
  // Round on the hundredths grid and parse back: `Math.round(x/0.05)*0.05`
  // reintroduces binary float noise (1.4000000000000001), which then drifts
  // every time a stored value is nudged again.
  return Number((Math.round(clamped * 20) / 20).toFixed(2));
}

function readStore(): Store | null {
  const res = loadJson<Store>(join(getAppDir(), FILENAME));
  if (res.status === "unreadable") {
    blockedFiles.add(FILENAME);
    log(`session-voice: NOT saving ${FILENAME} — it was unreadable at load.`);
    return null;
  }
  blockedFiles.delete(FILENAME);
  return res.status === "ok" ? res.data : {};
}

function writeStore(store: Store): void {
  if (blockedFiles.has(FILENAME)) return;
  saveJson(join(getAppDir(), FILENAME), store, { backup: true });
}

/** Normalize a stored entry to a valid settings object. */
function normalize(entry: unknown): SessionVoiceSettings {
  const e = entry as Partial<SessionVoiceSettings> | null;
  return {
    replyInVoice: typeof e?.replyInVoice === "boolean" ? e.replyInVoice : false,
    speed: typeof e?.speed === "number" ? clampSpeed(e.speed) : DEFAULT_SESSION_SETTINGS.speed,
    ...(typeof e?.voice === "string" && e.voice ? { voice: e.voice } : {}),
  };
}

/** Settings for a session; defaults when it has none. */
export function getSessionVoice(key: string): SessionVoiceSettings {
  const store = readStore();
  if (!store) return { ...DEFAULT_SESSION_SETTINGS };
  const entry = store[key];
  if (!entry) return { ...DEFAULT_SESSION_SETTINGS };
  return normalize(entry);
}

/** Merge an update into a session's settings; returns the effective settings. */
export function setSessionVoice(
  key: string,
  updates: Partial<Pick<SessionVoiceSettings, "replyInVoice" | "voice">> & { speed?: number },
): SessionVoiceSettings {
  const store = readStore() ?? {};
  const current = normalize(store[key]);
  if (typeof updates.replyInVoice === "boolean") current.replyInVoice = updates.replyInVoice;
  if (typeof updates.speed === "number") current.speed = clampSpeed(updates.speed);
  if (typeof updates.voice === "string") {
    if (updates.voice) current.voice = updates.voice;
    else delete current.voice;
  }
  store[key] = current;
  writeStore(store);
  return current;
}

/** Nudge a session's speed by `delta` (e.g. -0.1 slower, +0.1 faster). */
export function adjustSessionSpeed(key: string, delta: number): SessionVoiceSettings {
  const current = getSessionVoice(key);
  if (!Number.isFinite(delta)) return current;
  return setSessionVoice(key, { speed: current.speed + delta });
}
