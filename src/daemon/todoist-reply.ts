/**
 * daemon/todoist-reply.ts — answering on the task you were asked from.
 *
 * A task arriving here is often a question, not a work order, and until now the
 * answer went to a terminal the asker was not looking at. Filing from a watch
 * and reading the reply at a desk is not a channel; it is two half channels.
 *
 * So a session answers on the task itself. The comment carries the agent mark,
 * which `route()` already drops before anything else, so our own writes cannot
 * come back as instructions.
 *
 * Deliberately does NOT complete the task. Completion is the human saying done
 * — the same rule the receiver enforces on the way in — and a question whose
 * answer you have not read yet is not done. Left open, the task keeps its place
 * in the list with a comment indicator; completed, it vanishes from view and
 * the answer with it.
 */

import { AGENT_MARK } from "./todoist-webhook.js";
import { getAccessToken } from "./todoist-oauth.js";
import { log } from "../core/log.js";
import { audit } from "./audit.js";

export interface ReplyResult {
  commentId: string;
  taskId: string;
}

/** What a comment event needs from its parent task to be routable at all. */
export interface ParentTask {
  content: string;
  projectId: string;
  labels: string[];
}

/**
 * Fetch the task a comment belongs to.
 *
 * A `note:added` payload carries `item_id` and the comment text and nothing
 * else — no project, no labels. Without them the security boundary cannot be
 * evaluated, so a comment is unroutable until its parent is resolved. This is
 * the lookup that makes replying-by-comment possible at all.
 */
export async function fetchParentTask(
  taskId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ParentTask> {
  const token = await getAccessToken();
  if (!token) throw new Error("no Todoist authorisation on file — run `aibroker todoist auth`");

  const res = await fetchImpl(`https://api.todoist.com/api/v1/tasks/${encodeURIComponent(taskId)}`, {
    headers: { authorization: `${token.token_type} ${token.access_token}` },
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`task lookup failed with ${res.status}: ${raw.slice(0, 200)}`);

  let t: { content?: string; project_id?: string; labels?: unknown[] };
  try {
    t = JSON.parse(raw) as typeof t;
  } catch {
    throw new Error(`task lookup returned unparseable body: ${raw.slice(0, 200)}`);
  }
  return {
    content: t.content ?? "",
    projectId: t.project_id ?? "",
    labels: Array.isArray(t.labels) ? t.labels.map(String) : [],
  };
}

/**
 * Post a comment on a task as the agent.
 *
 * The mark is added here rather than trusted to callers: every path that can
 * write to Todoist has to be echo-safe, and "remember the prefix" is not a
 * safety mechanism.
 */
export async function replyToTask(
  taskId: string,
  text: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ReplyResult> {
  const token = await getAccessToken();
  if (!token) {
    throw new Error("no Todoist authorisation on file — run `aibroker todoist auth`");
  }
  const body = text.trimStart().startsWith(AGENT_MARK) ? text : `${AGENT_MARK} ${text}`;

  const res = await fetchImpl("https://api.todoist.com/api/v1/comments", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `${token.token_type} ${token.access_token}`,
    },
    body: JSON.stringify({ task_id: taskId, content: body }),
  });

  const raw = await res.text();
  if (!res.ok) throw new Error(`comment failed with ${res.status}: ${raw.slice(0, 200)}`);

  let parsed: { id?: string };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    throw new Error(`comment returned unparseable body: ${raw.slice(0, 200)}`);
  }

  const result = { commentId: parsed.id ?? "?", taskId };
  audit({
    action: "todoist-reply", actor: "aibroker", target: `todoist:task:${taskId}`,
    outcome: "posted", body,
  });
  log(`todoist-reply: commented on ${taskId}`);
  return result;
}

/** Normalise a title the way a human comparing two list rows would. */
function sameTitle(a: string, b: string): boolean {
  const n = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  return n(a) === n(b);
}

/**
 * How many OPEN tasks in this project share a title.
 *
 * Two tasks called the same thing are indistinguishable in a list, so a reply
 * posted on one looks — to whoever is watching the other — exactly like being
 * ignored. That cost two full rounds today: comment routing was working
 * perfectly and the answers were landing on a sibling nobody was looking at.
 * Being ignored and being answered elsewhere must not look the same.
 *
 * Returns 1 in the ordinary case (this task alone) and 0 when it cannot tell —
 * a lookup failure must not invent a duplicate warning.
 */
export async function countTasksWithTitle(
  projectId: string,
  title: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const token = await getAccessToken();
  if (!token || !projectId || !title.trim()) return 0;

  const res = await fetchImpl(
    `https://api.todoist.com/api/v1/tasks?project_id=${encodeURIComponent(projectId)}`,
    { headers: { authorization: `${token.token_type} ${token.access_token}` } },
  );
  if (!res.ok) return 0;

  let body: unknown;
  try {
    body = JSON.parse(await res.text());
  } catch {
    return 0;
  }
  // This endpoint has returned both a bare array and a {results:[…]} envelope
  // across versions; accept either rather than silently counting zero.
  const list: unknown[] = Array.isArray(body)
    ? body
    : Array.isArray((body as { results?: unknown[] })?.results)
      ? (body as { results: unknown[] }).results
      : [];

  return list.filter((t) => {
    const c = (t as { content?: string })?.content;
    return typeof c === "string" && sameTitle(c, title);
  }).length;
}

/**
 * Create a task as the agent.
 *
 * A session that files a task into an ingress project is writing into its own
 * inbox: `item:added` fires, routing sends it straight back, and the session
 * receives its own note as a work order. That happened on 2026-08-01 — a
 * session probing due-date parsing created a dozen test tasks and was handed
 * every one of them back within seconds.
 *
 * The mark is applied here rather than trusted to the caller, for the same
 * reason it is on replies: "remember the prefix" is not a safety mechanism.
 * `route()` drops marked content before anything else, so a task created this
 * way cannot come back as an instruction.
 */
export async function createTask(
  content: string,
  opts: { projectId?: string; description?: string; dueString?: string } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<{ taskId: string }> {
  const token = await getAccessToken();
  if (!token) throw new Error("no Todoist authorisation on file — run `aibroker todoist auth`");

  const marked = content.trimStart().startsWith(AGENT_MARK) ? content : `${AGENT_MARK} ${content}`;
  const res = await fetchImpl("https://api.todoist.com/api/v1/tasks", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `${token.token_type} ${token.access_token}`,
    },
    body: JSON.stringify({
      content: marked,
      project_id: opts.projectId,
      description: opts.description,
      due_string: opts.dueString,
    }),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`task create failed with ${res.status}: ${raw.slice(0, 200)}`);

  let parsed: { id?: string };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    throw new Error(`task create returned unparseable body: ${raw.slice(0, 200)}`);
  }
  audit({
    action: "todoist-task", actor: "aibroker", target: `todoist:project:${opts.projectId ?? "inbox"}`,
    outcome: "created", body: marked,
  });
  log(`todoist: created task ${parsed.id ?? "?"}`);
  return { taskId: parsed.id ?? "?" };
}

/**
 * Add or remove a label on a task.
 *
 * Used to CLAIM a trigger before dispatching it. Honouring another runner's
 * claim is only half an interlock: a path that dispatches and leaves the task
 * unclaimed lets the next poller see an advanced due date with no claim on it,
 * conclude the box was ticked, and dispatch the same work again.
 */
export async function setTaskLabel(
  taskId: string,
  label: string,
  present: boolean,
  fetchImpl: typeof fetch = fetch,
  attempt = 1,
): Promise<string[]> {
  const token = await getAccessToken();
  if (!token) throw new Error("no Todoist authorisation on file — run `aibroker todoist auth`");
  const auth = { authorization: `${token.token_type} ${token.access_token}` };

  const got = await fetchImpl(`https://api.todoist.com/api/v1/tasks/${encodeURIComponent(taskId)}`, { headers: auth });
  if (!got.ok) {
    // Todoist returns 401 with a retry_after for what behaves like throttling,
    // in bursts of a few seconds. One retry covers a flap; more would turn a
    // deliberate hint into a lock that blocks the dispatch behind it.
    const body = await got.text();
    const retryAfter = Number(/"retry_after"\s*:\s*(\d+)/.exec(body)?.[1] ?? 0);
    if (attempt === 1 && retryAfter > 0 && retryAfter <= 30) {
      await new Promise((r) => setTimeout(r, (retryAfter + 1) * 1000));
      return setTaskLabel(taskId, label, present, fetchImpl, 2);
    }
    throw new Error(`task lookup failed with ${got.status}${retryAfter ? ` (retry_after ${retryAfter}s)` : ""}`);
  }
  const current = JSON.parse(await got.text()) as { labels?: unknown[] };
  const labels = Array.isArray(current.labels) ? current.labels.map(String) : [];

  const has = labels.some((l) => l.toLowerCase() === label.toLowerCase());
  if (has === present) return labels;
  const next = present
    ? [...labels, label]
    : labels.filter((l) => l.toLowerCase() !== label.toLowerCase());

  const res = await fetchImpl(`https://api.todoist.com/api/v1/tasks/${encodeURIComponent(taskId)}`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ labels: next }),
  });
  if (!res.ok) throw new Error(`label update failed with ${res.status}: ${(await res.text()).slice(0, 120)}`);
  return next;
}

/** The task's current due date, or undefined when it has none or cannot be read. */
export async function fetchTaskDue(
  taskId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> {
  try {
    const token = await getAccessToken();
    if (!token) return undefined;
    const res = await fetchImpl(`https://api.todoist.com/api/v1/tasks/${encodeURIComponent(taskId)}`, {
      headers: { authorization: `${token.token_type} ${token.access_token}` },
    });
    if (!res.ok) return undefined;
    const t = JSON.parse(await res.text()) as { due?: { date?: string } };
    return t.due?.date;
  } catch {
    // Unreadable is not "not completed" — the caller treats undefined as
    // "cannot tell" and allows the release rather than stranding a finished run.
    return undefined;
  }
}
