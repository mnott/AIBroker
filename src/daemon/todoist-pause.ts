/**
 * daemon/todoist-pause.ts — a pause switch for Todoist inbound delivery.
 *
 * Bulk-cleaning Todoist (deleting comments, completing old tasks) should not
 * fire work orders into sessions mid-clean-up. The only off switch that
 * existed was removing TODOIST_CLIENT_SECRET or setting TODOIST_DUE_POLL_MINUTES=0
 * and restarting the daemon — which also takes down PAILot and WhatsApp,
 * because they share the listener. This pauses delivery alone.
 *
 * State lives in one small JSON file under the AIBroker state dir, so it
 * survives a daemon restart and the CLI needs no daemon socket: both sides
 * read the file on every check, so a pause set by the CLI is honoured by the
 * running daemon immediately and vice versa.
 *
 * An expiry auto-resumes: a forgotten pause must not silence the channel
 * forever. Default 60 minutes; `--minutes N` overrides it.
 *
 * Events dropped while paused are NOT replayed on resume — the whole point is
 * that the clean-up churn should never reach a session.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { unlinkSync } from "node:fs";
import { loadJson, saveJson } from "../core/json-store.js";

const FILE = join(homedir(), ".aibroker", "todoist-pause.json");

/** A pause with no explicit expiry auto-resumes after this. */
export const DEFAULT_PAUSE_MINUTES = 60;

interface PauseState {
  pausedUntil: string;
  reason?: string;
}

/**
 * Is delivery paused right now?
 *
 * Reads the file on every call — no in-process cache. The writer is usually a
 * different process (the CLI), and a cached "paused" would keep the daemon
 * deaf after `resume`, or keep it listening after `pause`. A past expiry is
 * simply not paused; nothing needs to rewrite the file to resume.
 */
export function isPaused(): boolean {
  const res = loadJson<PauseState>(FILE);
  if (res.status !== "ok" || !res.data?.pausedUntil) return false;
  const until = Date.parse(res.data.pausedUntil);
  return Number.isFinite(until) && until > Date.now();
}

/** The live pause, or null when not paused (an expired pause reads as null). */
export function currentPause(): PauseState | null {
  const res = loadJson<PauseState>(FILE);
  if (res.status !== "ok" || !res.data?.pausedUntil) return null;
  const until = Date.parse(res.data.pausedUntil);
  if (!Number.isFinite(until) || until <= Date.now()) return null;
  return res.data;
}

/** Pause delivery until `minutes` from now. */
export function setPause(minutes: number = DEFAULT_PAUSE_MINUTES): PauseState {
  const state: PauseState = {
    pausedUntil: new Date(Date.now() + minutes * 60_000).toISOString(),
  };
  saveJson(FILE, state, { backup: false });
  return state;
}

/** Resume now: the file is removed, so a later status says "not paused". */
export function clearPause(): void {
  try { unlinkSync(FILE); } catch { /* already gone — resumed either way */ }
}
