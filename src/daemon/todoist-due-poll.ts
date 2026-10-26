/**
 * daemon/todoist-due-poll.ts — due tasks in ingress projects, polled.
 *
 * Todoist pushes `reminder:fired` and item events, but a task merely BECOMING
 * due fires nothing. A due task without a reminder, or one whose reminder
 * dispatch failed once, therefore never arrives — for two days nothing came
 * from the Jobs projects while Todoist showed them as due.
 *
 * So the daemon also asks. Every N minutes (TODOIST_DUE_POLL_MINUTES, default
 * 5, 0 disables) the open tasks of each ingress project (and subtree children
 * of subtree grants) are listed, and a task that is due or overdue is handed to
 * the same routing and dispatch path a webhook uses, as a synthetic
 * `reminder:fired`.
 *
 * Idempotent: a task is dispatched once per due date. The key is task id + due
 * (date or datetime), stored on disk, and is written only once the task was
 * handled — delivered, or refused by routing. A dispatch that could not land
 * (no alias, registry down, session unreachable) leaves no key and is retried
 * on the next tick. The webhook path records the same key, so a reminder that
 * already ran a task is not run again by the poll.
 *
 * Overdue is bounded (TODOIST_DUE_POLL_MAX_OVERDUE_DAYS, default 7) so enabling
 * the poll does not resurrect months-old tasks.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { loadJson, saveJson } from "../core/json-store.js";
import { log } from "../core/log.js";
import { getAccessToken } from "./todoist-oauth.js";

const FILE = join(homedir(), ".aibroker", "todoist-due-handled.json");
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;

/** Outcomes that mean "did not land, try again" — everything else is final. */
const RETRY_OUTCOMES = new Set(["unlaunchable", "unreachable", "failed", "error"]);

export interface DueTask {
  id: string;
  content: string;
  project_id: string;
  labels: string[];
  description?: string;
  due: { date: string; datetime?: string | null; is_recurring?: boolean };
  [k: string]: unknown;
}

interface Store { handled: Record<string, string> }

function read(): Store {
  const r = loadJson<Store>(FILE);
  if (r.status === "ok" && r.data?.handled) return r.data;
  return { handled: {} };
}

/** Task id + the due occurrence it was handled for. */
export function dueKey(taskId: string, due: { date?: string; datetime?: string | null } | undefined): string {
  return `${taskId}@${due?.datetime || due?.date || ""}`;
}

export function isDueHandled(key: string): boolean { return key in read().handled; }

export function recordDueHandled(key: string): void {
  const s = read();
  s.handled[key] = new Date().toISOString();
  const cut = Date.now() - KEEP_MS;
  for (const [k, at] of Object.entries(s.handled)) if (Date.parse(at) < cut) delete s.handled[k];
  saveJson(FILE, s);
}

/** Should a dispatch outcome be remembered (true) or retried (false)? */
export function outcomeIsFinal(outcome: string | undefined): boolean {
  return outcome !== undefined && !RETRY_OUTCOMES.has(outcome);
}

/**
 * Is this task due now, and not older than `maxOverdueDays`?
 *
 * A date-only due is due from the start of that local day; a datetime from that
 * instant (a floating datetime without zone parses as local time).
 */
export function isDueNow(due: DueTask["due"] | undefined, now = new Date(), maxOverdueDays = 7): boolean {
  if (!due?.date) return false;
  const stamp = due.datetime || due.date;
  const t = stamp.includes("T") ? new Date(stamp) : new Date(`${stamp}T00:00:00`);
  if (Number.isNaN(t.getTime())) return false;
  const age = now.getTime() - t.getTime();
  return age >= 0 && age <= maxOverdueDays * 86_400_000 + (stamp.includes("T") ? 0 : 86_400_000);
}

/** All open tasks of one project, following the pagination cursor. */
export async function listProjectTasks(
  projectId: string, fetchImpl: typeof fetch = fetch,
): Promise<DueTask[]> {
  const token = await getAccessToken();
  if (!token) throw new Error("no Todoist access token");
  const out: DueTask[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const url = `https://api.todoist.com/api/v1/tasks?project_id=${encodeURIComponent(projectId)}&limit=200` +
      (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    const res = await fetchImpl(url, { headers: { authorization: `${token.token_type} ${token.access_token}` } });
    if (!res.ok) throw new Error(`task listing for ${projectId} failed with ${res.status}`);
    const body = JSON.parse(await res.text()) as { results?: DueTask[]; next_cursor?: string | null } | DueTask[];
    const list = Array.isArray(body) ? body : (body.results ?? []);
    for (const t of list) if (t && t.id) out.push({ ...t, labels: Array.isArray(t.labels) ? t.labels : [] });
    cursor = Array.isArray(body) ? undefined : body.next_cursor ?? undefined;
    if (!cursor) break;
  }
  return out;
}

export interface DuePollDeps {
  /** Ingress project ids to scan: configured, granted, and subtree children. */
  projectIds: () => Promise<string[]>;
  listTasks: (projectId: string) => Promise<DueTask[]>;
  /** Route and dispatch one task; returns the dispatch outcome. */
  handle: (task: DueTask) => Promise<string | undefined>;
  now?: () => Date;
  maxOverdueDays?: number;
  runningLabel: string;
}

export interface DuePollDecision { task: DueTask; action: "dispatch" | "skip"; why: string }

/** Which tasks a tick would dispatch — pure of side effects, for dry runs. */
export async function planDuePoll(deps: DuePollDeps): Promise<DuePollDecision[]> {
  const now = (deps.now ?? (() => new Date()))();
  const decisions: DuePollDecision[] = [];
  for (const pid of await deps.projectIds()) {
    let tasks: DueTask[];
    try { tasks = await deps.listTasks(pid); } catch (e) {
      log(`todoist-due-poll: could not list ${pid} — ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    for (const task of tasks) {
      if (!task.due) continue;
      if (!isDueNow(task.due, now, deps.maxOverdueDays)) continue;
      if (task.labels.some((l) => l.toLowerCase() === deps.runningLabel)) {
        decisions.push({ task, action: "skip", why: `in flight (${deps.runningLabel})` });
      } else if (isDueHandled(dueKey(task.id, task.due))) {
        decisions.push({ task, action: "skip", why: "already handled for this due date" });
      } else {
        decisions.push({ task, action: "dispatch", why: "due and not yet handled" });
      }
    }
  }
  return decisions;
}

let ticking = false;

/** One poll tick. Returns the decisions taken. */
export async function runDuePoll(deps: DuePollDeps): Promise<DuePollDecision[]> {
  if (ticking) return [];
  ticking = true;
  try {
    const decisions = await planDuePoll(deps);
    for (const d of decisions) {
      if (d.action !== "dispatch") continue;
      let outcome: string | undefined;
      try { outcome = await deps.handle(d.task); } catch (e) {
        outcome = "error";
        log(`todoist-due-poll: ${d.task.id} failed — ${e instanceof Error ? e.message : String(e)}`);
      }
      if (outcomeIsFinal(outcome)) recordDueHandled(dueKey(d.task.id, d.task.due));
      else log(`todoist-due-poll: ${d.task.id} not landed (${outcome ?? "no outcome"}) — will retry next tick`);
    }
    return decisions;
  } finally {
    ticking = false;
  }
}
