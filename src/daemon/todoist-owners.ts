/**
 * daemon/todoist-owners.ts — which session took which task.
 *
 * A comment on a task is a correction to work already in flight: "actually, do
 * it this way", "that's wrong, try again". It has to reach the session holding
 * that work, and re-deriving the owner from the parent's project and labels is
 * not the same thing. The original may have been addressed in its title — "pai
 * send me a mail" — while the comment says only "make it next month". Re-derive
 * and the correction lands on whatever the project or the default says, which
 * is a different session than the one that did the work.
 *
 * So the owner is remembered at delivery and preferred at comment time.
 *
 * Bounded and on disk: bounded because this is a cache, not a ledger, and on
 * disk because the daemon restarts more often than a conversation ends.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { loadJson, saveJson } from "../core/json-store.js";

const FILE = join(homedir(), ".aibroker", "todoist-owners.json");

/** Enough for any live conversation; old entries are not worth keeping. */
const MAX = 500;

interface Store {
  /** taskId -> owner, oldest first so trimming is a shift. */
  order: string[];
  owners: Record<string, string>;
}

function empty(): Store {
  return { order: [], owners: {} };
}

function read(): Store {
  const r = loadJson<Store>(FILE);
  // An unreadable cache is not a reason to lose the daemon: start empty and
  // let the next delivery repopulate it. Never erase the file on a parse error
  // — that is the bug core/json-store exists to avoid.
  if (r.status === "ok" && Array.isArray(r.data?.order) && r.data?.owners) return r.data;
  return empty();
}

/** Record who took a task, so a later comment on it reaches the same session. */
export function rememberOwner(taskId: string, owner: string): void {
  if (!taskId || !owner) return;
  const s = read();
  if (!(taskId in s.owners)) s.order.push(taskId);
  s.owners[taskId] = owner;
  while (s.order.length > MAX) {
    const drop = s.order.shift();
    if (drop) delete s.owners[drop];
  }
  saveJson(FILE, s);
}

/** Who took this task, if we still know. */
export function ownerOf(taskId: string): string | undefined {
  if (!taskId) return undefined;
  return read().owners[taskId];
}

/** Test seam: forget everything. */
export function forgetAllOwners(): void {
  saveJson(FILE, empty());
}
