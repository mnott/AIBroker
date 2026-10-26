/**
 * Where a session id the app still holds went.
 *
 * An iTerm or Claude restart gives a tab a NEW id. The app keeps the old one
 * (it persists the active id), so every send misses. The persistent name store
 * cannot answer "what was that id?" — it prunes bindings to dead tabs within
 * minutes. This keeps a small, longer-lived record of id → name+cwd for every
 * id ever seen live, so a stale id resolves to the live session carrying the
 * same name (and cwd, as the tiebreak) whether the old session was restored or
 * simply killed and started again by hand.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface SeenSession { name: string; cwd: string; lastSeen: number }
type History = Record<string, SeenSession>;

const DEFAULT_FILE = join(homedir(), ".aibroker", "session-history.json");
const MAX_ENTRIES = 500;
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;

let cache: { file: string; data: History } | undefined;

function load(file: string): History {
  if (cache?.file === file) return cache.data;
  let data: History = {};
  try {
    if (existsSync(file)) data = JSON.parse(readFileSync(file, "utf-8")) as History;
  } catch { data = {}; }
  cache = { file, data };
  return data;
}

function save(file: string, data: History): void {
  const now = Date.now();
  const keys = Object.keys(data).filter(k => now - data[k].lastSeen <= MAX_AGE_MS);
  keys.sort((a, b) => data[b].lastSeen - data[a].lastSeen);
  const keep: History = {};
  for (const k of keys.slice(0, MAX_ENTRIES)) keep[k] = data[k];
  cache = { file, data: keep };
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(keep, null, 2) + "\n");
  renameSync(tmp, file);
}

/** Remember the live sessions. Writes only when a name or cwd changed or an id is new. */
export function recordSessions(
  sessions: { backendSessionId: string; name: string; cwd?: string }[],
  file = DEFAULT_FILE,
): void {
  const data = load(file);
  let dirty = false;
  const now = Date.now();
  for (const s of sessions) {
    if (!s.backendSessionId || !s.name) continue;
    const prev = data[s.backendSessionId];
    const cwd = s.cwd ?? prev?.cwd ?? "";
    if (!prev || prev.name !== s.name || prev.cwd !== cwd) {
      data[s.backendSessionId] = { name: s.name, cwd, lastSeen: now };
      dirty = true;
    }
  }
  if (dirty) save(file, data);
}

/**
 * The live session that took over `oldId`: same recorded name, the one with the
 * same cwd when several share the name. Undefined when nothing carries the name.
 */
export function successorOf<T extends { backendSessionId: string; name: string; cwd?: string }>(
  oldId: string,
  live: T[],
  file = DEFAULT_FILE,
  fallbackName?: string,
): T | undefined {
  const old = load(file)[oldId];
  const name = old?.name ?? fallbackName;
  if (!name) return undefined;
  const byName = live.filter(s => s.name === name && s.backendSessionId !== oldId);
  if (byName.length <= 1) return byName[0];
  return byName.find(s => old?.cwd && s.cwd === old.cwd) ?? byName[0];
}
