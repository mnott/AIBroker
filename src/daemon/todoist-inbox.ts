/**
 * daemon/todoist-inbox.ts — what has been commented on since you last looked.
 *
 * A push per reply tells you something happened the moment it happens. That is
 * the wrong shape for the actual problem: a tree of hundreds of tasks, comments
 * arriving on any of them, and no way to see which ones are waiting for you.
 * Todoist itself will not help — it does not notify an account about its own
 * activity, and every comment the bridge writes is written as you, so the one
 * event you most want to know about is precisely the one Todoist stays quiet
 * about.
 *
 * So this reads the activity log — one request, not one per task — groups the
 * comments by the task they landed on, and hands back a list you can jump from.
 * The read marker is stored, so "what's new" means new since you last asked
 * rather than new since some arbitrary window.
 *
 * The marker is only advanced when the caller says so. A digest that marks
 * everything read as a side effect of being built would lose the whole backlog
 * the first time a scheduled job ran before you saw it.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { loadJson, saveJson } from "../core/json-store.js";
import { log } from "../core/log.js";
import { getAccessToken } from "./todoist-oauth.js";
import { fetchTaskBrief } from "./todoist-reply.js";

const FILE = join(homedir(), ".aibroker", "todoist-inbox.json");

/** How many activity records to pull. Todoist caps the page; this is the ask. */
const ACTIVITY_LIMIT = 100;

/**
 * How many tasks get their title resolved.
 *
 * Each title is one API call. A digest of forty tasks is not a digest, and
 * forty extra calls to build one is worse, so the list is capped and the
 * remainder is reported as a count rather than silently dropped.
 */
const RESOLVE_LIMIT = 20;

export interface InboxComment {
  at: string;
  content: string;
  /** The app that wrote it — "AIBroker Bridge" for a session's reply. */
  client?: string;
}

export interface InboxEntry {
  taskId: string;
  projectId?: string;
  title?: string;
  url?: string;
  comments: InboxComment[];
  /** Newest comment on this task, for ordering. */
  latest: string;
}

export interface Inbox {
  entries: InboxEntry[];
  /** Tasks that had new comments but whose titles were not resolved. */
  truncated: number;
  /** The marker this digest was computed against. */
  since?: string;
  /** The newest event seen, which becomes the marker if the caller commits. */
  newest?: string;
}

interface Store {
  lastSeen?: string;
}

function read(): Store {
  const r = loadJson<Store>(FILE);
  if (r.status === "ok" && r.data) return r.data;
  if (r.status === "unreadable") {
    // Treat an unreadable marker as "never looked" rather than "all seen":
    // showing a comment twice is a nuisance, hiding one is the failure this
    // whole module exists to end.
    log(`todoist-inbox: ${FILE} is unreadable — treating as never read`);
  }
  return {};
}

/** When the inbox was last marked read. Undefined means never. */
export function lastSeen(): string | undefined {
  return read().lastSeen;
}

/** Record that everything up to `at` has been seen. */
export function markSeen(at: string): void {
  saveJson(FILE, { lastSeen: at });
}

export interface ActivityRecord {
  /** The comment's own id — the only stable key for "already handled". */
  object_id?: string;
  event_date?: string;
  parent_item_id?: string;
  parent_project_id?: string;
  extra_data?: { content?: string; client?: string };
}

/**
 * Comment events, newest first.
 *
 * Returns an empty list rather than throwing when Todoist cannot be reached —
 * the caller is building a digest, and a digest that fails loudly on a network
 * blip is a digest that gets turned off.
 */
export async function fetchCommentActivity(
  fetchImpl: typeof fetch = fetch,
): Promise<ActivityRecord[]> {
  const token = await getAccessToken();
  if (!token) {
    log("todoist-inbox: no Todoist authorisation on file");
    return [];
  }
  const url =
    `https://api.todoist.com/api/v1/activities` +
    `?object_type=note&event_type=added&limit=${ACTIVITY_LIMIT}`;
  try {
    const res = await fetchImpl(url, {
      headers: { authorization: `${token.token_type} ${token.access_token}` },
    });
    if (!res.ok) {
      log(`todoist-inbox: activity request failed with ${res.status}`);
      return [];
    }
    const body = JSON.parse(await res.text()) as { results?: ActivityRecord[] };
    return Array.isArray(body.results) ? body.results : [];
  } catch (e) {
    log(`todoist-inbox: could not read activity — ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

/**
 * Group new comments by the task they landed on.
 *
 * `since` defaults to the stored read marker. Pass it explicitly to look
 * further back without disturbing the marker.
 */
export async function buildInbox(opts: { since?: string } = {}): Promise<Inbox> {
  const since = opts.since ?? lastSeen();
  const records = await fetchCommentActivity();

  const fresh = records.filter((r) => {
    if (!r.event_date || !r.parent_item_id) return false;
    return since ? r.event_date > since : true;
  });

  const newest = records.map((r) => r.event_date).filter(Boolean).sort().pop() as string | undefined;

  const byTask = new Map<string, InboxEntry>();
  for (const r of fresh) {
    const id = r.parent_item_id!;
    const entry = byTask.get(id) ?? {
      taskId: id,
      projectId: r.parent_project_id,
      comments: [],
      latest: r.event_date!,
    };
    entry.comments.push({
      at: r.event_date!,
      content: r.extra_data?.content ?? "",
      client: r.extra_data?.client,
    });
    if (r.event_date! > entry.latest) entry.latest = r.event_date!;
    byTask.set(id, entry);
  }

  const entries = [...byTask.values()].sort((a, b) => b.latest.localeCompare(a.latest));
  const resolve = entries.slice(0, RESOLVE_LIMIT);

  // Titles in parallel — a serial loop over twenty tasks is a visible pause.
  await Promise.all(
    resolve.map(async (e) => {
      const brief = await fetchTaskBrief(e.taskId);
      e.title = brief.title;
      e.url = brief.url;
    }),
  );

  return {
    entries: resolve,
    truncated: Math.max(0, entries.length - resolve.length),
    since,
    newest,
  };
}

/**
 * The digest as text, ready for a phone.
 *
 * A deleted task resolves to no title; it is still listed, because "a comment
 * arrived on something that no longer exists" is information, not noise.
 */
export function formatInbox(inbox: Inbox): string {
  if (inbox.entries.length === 0) {
    return inbox.since
      ? `No new Todoist comments since ${inbox.since.slice(0, 16).replace("T", " ")}.`
      : "No Todoist comments found.";
  }

  const lines: string[] = [
    `📋 ${inbox.entries.length} task${inbox.entries.length === 1 ? "" : "s"} with new comments`,
    "",
  ];
  for (const e of inbox.entries) {
    const when = e.latest.slice(11, 16);
    lines.push(`• ${e.title ?? `(task ${e.taskId})`} — ${when}`);
    const last = e.comments[0];
    if (last?.content) lines.push(`  ${last.content.replace(/\s+/g, " ").slice(0, 140)}`);
    if (e.comments.length > 1) lines.push(`  (+${e.comments.length - 1} more)`);
    if (e.url) lines.push(`  ${e.url}`);
  }
  if (inbox.truncated > 0) {
    lines.push("", `…and ${inbox.truncated} more task${inbox.truncated === 1 ? "" : "s"} not shown.`);
  }
  return lines.join("\n");
}
