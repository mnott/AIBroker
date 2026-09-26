/**
 * daemon/todoist-pending.ts — a reminder or comment whose parent task could not
 * be resolved yet is not gone, it is waiting.
 *
 * Resolving `reminder:fired`/`note:added` means one Todoist API call
 * (`fetchParentTask`) on the daemon's own event loop. A busy loop or a flaky
 * network turns that call into "fetch failed" for reasons that have nothing to
 * do with whether the task exists — see audit ab-mudmf06z, a reminder dropped
 * with exactly that message while the event loop was blocked (fixed in
 * 0.58.1). Treating that the same as "no such task" loses a real event.
 *
 * So a transient failure is queued here instead of dropped, and outlives both
 * the inline backoff in todoist-webhook.ts and a daemon restart: the sweep
 * that drains this file runs once shortly after `startTodoistWebhook` and
 * again on every tick after that.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { loadJson, saveJson } from "../core/json-store.js";
import type { TodoistEvent } from "./todoist-webhook.js";

const FILE = join(homedir(), ".aibroker", "todoist-pending.json");

export interface PendingEvent {
  /** `eventKey()` of the original event — dedupes queueing and drives removal. */
  key: string;
  event: TodoistEvent;
  kind: "reminder" | "comment";
  parentId: string;
  firstSeenAt: string;
  attempts: number;
  lastError: string;
}

interface Store { pending: PendingEvent[] }

function read(): Store {
  const r = loadJson<Store>(FILE);
  if (r.status === "ok" && r.data?.pending) return r.data;
  return { pending: [] };
}

function write(s: Store): void { saveJson(FILE, s); }

export function listPendingEvents(): PendingEvent[] { return read().pending; }

/** No-op if `key` is already queued — the sweep will retry it regardless. */
export function queuePendingEvent(p: {
  key: string; event: TodoistEvent; kind: "reminder" | "comment"; parentId: string; lastError: string;
}): void {
  const s = read();
  if (s.pending.some((e) => e.key === p.key)) return;
  s.pending.push({ ...p, firstSeenAt: new Date().toISOString(), attempts: 0 });
  write(s);
}

export function removePendingEvent(key: string): void {
  const s = read();
  const next = s.pending.filter((e) => e.key !== key);
  if (next.length !== s.pending.length) write({ pending: next });
}

export function bumpPendingEvent(key: string, error: string): void {
  const s = read();
  const e = s.pending.find((p) => p.key === key);
  if (!e) return;
  e.attempts += 1;
  e.lastError = error;
  write(s);
}

/**
 * Older than this, a pending event is not "waiting for the network to recover"
 * — nothing here is expected to be down for a day. Giving up keeps the queue
 * from becoming a second, invisible audit log.
 */
export const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
