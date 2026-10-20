/**
 * daemon/pai-session-map.ts — the caller's own session, when the env is silent.
 *
 * "Arm yourself", "set your goal", "supervise self" all mean: the session that
 * is asking. That used to be answered by ITERM_SESSION_ID alone — iTerm puts
 * the id in the environment of every shell it spawns — and it failed exactly
 * where self-arming matters most: sessions run under the Claude background
 * daemon carry no ITERM_SESSION_ID at all, so every one of them was refused
 * with "run this from inside your own session" while the operator slept. The
 * overnight supervised sessions are daemon-run by construction.
 *
 * PAI ≥ 0.71.0 keeps a registry that answers the same question from the other
 * side: ~/.claude/pai/session-claude-map.json, written by the statusline,
 * whose process has BOTH halves of the mapping — the claude session id on
 * stdin and ITERM_SESSION_ID in its environment:
 *
 *   { "<claudeSessionId>": { "uid": "<iTerm session uuid>", "ts": <epoch ms> } }
 *
 * This module is the one reader of that file for self-resolution. Two paths
 * share it — `aibroker arm-self` (cli.ts) and the hub's session=self resolution
 * (core-handlers.ts) — and no second mapping source is invented anywhere: if
 * the map is missing, unreadable or not the shape PAI writes, the caller is
 * refused exactly as before. A guess that names the wrong session would arm
 * the wrong watcher, and a refusal is recoverable while a mis-armed watcher
 * types goals into someone else's terminal.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** One entry as PAI's statusline writes it. Fields are read defensively: the file is another program's output. */
export interface PaiSessionMapEntry {
  uid?: unknown;
  ts?: unknown;
}

export type PaiSessionMap = Record<string, PaiSessionMapEntry>;

/**
 * How far back the newest-entry fallback looks. Refreshed on every statusline
 * render, so a live session's entry is seconds old; the window exists to
 * exclude panes that were closed hours ago and whose entry nobody will ever
 * refresh again.
 */
export const PAI_MAP_FALLBACK_WINDOW_MS = 2 * 3_600_000;

export function paiSessionMapPath(home: string = homedir()): string {
  return join(home, ".claude", "pai", "session-claude-map.json");
}

/** undefined when the file is missing, unreadable, or not an object — the registry has nothing to say. */
export function readPaiSessionMap(mapPath: string = paiSessionMapPath()): PaiSessionMap | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(mapPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as PaiSessionMap;
  } catch {
    return undefined;
  }
}

/**
 * The caller's claude session uuid, from whichever env name carries it.
 * Claude Code exports CLAUDE_CODE_SESSION_ID; CLAUDE_SESSION_ID is the older
 * spelling some launchers still set.
 */
export function envClaudeSessionId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const id = (env.CLAUDE_CODE_SESSION_ID ?? env.CLAUDE_SESSION_ID ?? "").trim();
  return id || undefined;
}

/**
 * iTerm announces `w<window>t<tab>p<pane>:<uuid>`; the registry, managers.json
 * and the hub's session list all key the bare uuid. iTerm's composite id and
 * the uuid name the same session, so both are accepted everywhere here.
 */
export function paneSuffix(id: string | undefined | null): string {
  if (!id) return "";
  return id.includes(":") ? id.slice(id.lastIndexOf(":") + 1) : id;
}

export interface SelfSession {
  /** The pane-suffix form — the shape managers.json and the hub's list are keyed by. */
  id: string;
  via: "iterm-env" | "claude-env-id" | "newest-fresh";
  /** The map entry's ts was refreshed on disk (claude-env-id matches only — see below). */
  mapRefreshed: boolean;
}

export interface ResolveSelfOpts {
  /** ITERM_SESSION_ID of the caller, when the caller has one. Wins outright; the map is not consulted. */
  itermSessionId?: string;
  /**
   * The caller's claude session uuid, when the caller already knows it. For the
   * CLI this comes from the CLI's own env; for the hub from the request, which
   * the client resolved in the CALLER's env. Never defaulted to process.env by
   * this module: a hub reading its own env would resolve callers to whatever
   * session the daemon itself was last started from.
   */
  claudeSessionId?: string;
  /**
   * Read only when opts.env is given: the claude session id is taken from
   * CLAUDE_CODE_SESSION_ID, then CLAUDE_SESSION_ID.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * The hub's live session ids. Consulted only by the newest-entry fallback —
   * lazily, so a caller resolved by its env id never pays for the enumeration.
   * An empty list means nothing can be confirmed live, and the fallback
   * abstains rather than guess.
   */
  knownUids?: Iterable<string> | (() => Iterable<string> | Promise<Iterable<string>>);
  mapPath?: string;
  now?: number;
}

/**
 * Which session is "self" for this caller — the one shared answer used by the
 * CLI's arm-self and the hub's session=self resolution.
 *
 * Precedence:
 *   1. ITERM_SESSION_ID — what the environment says, as before this file existed.
 *   2. Exact match on the claude session id. Authoritative at ANY age: the map
 *      is keyed by the session's own uuid, so a hit is this session by
 *      definition, however stale the timestamp. The entry's ts is refreshed on
 *      use (best effort — a registry that cannot be written is not a reason to
 *      refuse a resolution that already succeeded). No hit is NOT a reason to
 *      fall through to the newest-entry guess: knowing one's own id and not
 *      finding it means the map does not know this session, and guessing then
 *      would be guessing AGAINST evidence.
 *   3. The unambiguous fresh entry naming a live session — only when the
 *      caller has no id at all, exactly one map entry is fresh (last 2 h) and
 *      names a session in the hub's list. Two candidates is one too many: the
 *      cost of arming the wrong session dwarfs the cost of asking again.
 */
export async function resolveSelfSessionId(opts: ResolveSelfOpts = {}): Promise<SelfSession | undefined> {
  const iterm = paneSuffix(opts.itermSessionId);
  if (iterm) return { id: iterm, via: "iterm-env", mapRefreshed: false };

  const mapPath = opts.mapPath ?? paiSessionMapPath();
  const map = readPaiSessionMap(mapPath);
  if (!map) return undefined;

  const now = opts.now ?? Date.now();
  const claudeId = opts.claudeSessionId ?? (opts.env ? envClaudeSessionId(opts.env) : undefined);

  if (claudeId) {
    const entry = entryFor(map, claudeId);
    const uid = paneSuffix(typeof entry?.uid === "string" ? entry.uid : undefined);
    if (!entry || !uid) return undefined;
    let mapRefreshed = false;
    if (entry.ts !== now) {
      entry.ts = now;
      try {
        writeFileSync(mapPath, JSON.stringify(map));
        mapRefreshed = true;
      } catch {
        mapRefreshed = false; // read-only or vanished mid-run: the resolution stands regardless
      }
    }
    return { id: uid, via: "claude-env-id", mapRefreshed };
  }

  const live = new Set(
    (await knownUids(opts.knownUids))
      .map((id) => paneSuffix(id).toLowerCase())
      .filter(Boolean),
  );
  /** One slot per live session, however many claude ids point at it; the newest ts wins the slot. */
  const candidates = new Map<string, { uid: string; ts: number }>();
  for (const e of Object.values(map)) {
    const uid = paneSuffix(typeof e?.uid === "string" ? e.uid : undefined);
    const ts = typeof e?.ts === "number" ? e.ts : NaN;
    if (!uid || !Number.isFinite(ts) || now - ts > PAI_MAP_FALLBACK_WINDOW_MS) continue;
    if (!live.has(uid.toLowerCase())) continue;
    const prev = candidates.get(uid.toLowerCase());
    if (!prev || prev.ts < ts) candidates.set(uid.toLowerCase(), { uid, ts });
  }
  if (candidates.size !== 1) return undefined;
  const only = [...candidates.values()][0];
  return { id: only.uid, via: "newest-fresh", mapRefreshed: false };
}

function entryFor(map: PaiSessionMap, claudeId: string): PaiSessionMapEntry | undefined {
  const direct = map[claudeId];
  if (direct) return direct;
  const lower = claudeId.toLowerCase();
  for (const [k, v] of Object.entries(map)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

async function knownUids(
  source: ResolveSelfOpts["knownUids"],
): Promise<string[]> {
  try {
    return [...(typeof source === "function" ? await source() : source ?? [])];
  } catch {
    return []; // an enumeration that fails is an enumeration that found nothing confirmable
  }
}
