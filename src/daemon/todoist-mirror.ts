/**
 * daemon/todoist-mirror.ts — new comments, filed where you will actually see them.
 *
 * Todoist never notifies an account about its own activity, and every comment a
 * session writes is written as the account owner. So a reply lands on a task
 * somewhere in a tree of hundreds and is, from the outside, indistinguishable
 * from nothing having happened. `todoist-inbox.ts` answers that on demand. This
 * answers it without being asked: each new comment becomes a task in a mirror
 * project, grouped into a section named after the project the comment came
 * from, linking straight back to the conversation.
 *
 * The sections are managed, not configured. A project that gets commented on
 * gains a section; a section whose items have all been dealt with is removed
 * again on the next run. That keeps the mirror shaped like what is currently
 * outstanding rather than like a history of everything that ever happened —
 * a list nobody prunes is a list nobody reads.
 *
 * Three things this must never do, each of which it would do naturally:
 *
 *  - **Feed itself.** A comment on a mirror task is a comment, and mirroring it
 *    would create a task, whose comments would create tasks. Anything parented
 *    in the mirror project is skipped, and the mirror project is never an
 *    ingress project, so its tasks cannot be dispatched as work either.
 *  - **Replay.** The read marker moves only after a successful pass, and every
 *    mirrored comment id is remembered, because a marker alone loses a race
 *    with a comment posted in the same second it was written.
 *  - **Delete a section someone else made.** Only sections this module created
 *    are pruned, tracked by id, never by name.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { loadJson, saveJson } from "../core/json-store.js";
import { log } from "../core/log.js";
import { audit } from "./audit.js";
import { getAccessToken } from "./todoist-oauth.js";
import { projectTree } from "./todoist-projects.js";
import { fetchCommentActivity } from "./todoist-inbox.js";
import { fetchTaskBrief } from "./todoist-reply.js";
import { AGENT_MARK } from "./todoist-webhook.js";

const FILE = join(homedir(), ".aibroker", "todoist-mirror.json");
const API = "https://api.todoist.com/api/v1";

/**
 * How many comment ids to remember.
 *
 * Only needs to cover the window the marker cannot: comments sharing a second
 * with the marker, and a pass that half-failed. A few hundred is generous.
 */
const SEEN_LIMIT = 500;

/** Ceiling on one pass, so a long absence cannot flood the mirror in one go. */
const MAX_PER_RUN = 40;

interface Store {
  /** Newest comment timestamp successfully mirrored. */
  lastSeen?: string;
  /** Comment ids already mirrored, newest last. */
  seen?: string[];
  /** Sections this module created, id → source project id. */
  sections?: Record<string, string>;
  /**
   * Comments we wrote but could not mirror, retried on the next write.
   *
   * The direct path replaces polling, which means it also inherits polling's
   * job of not losing anything. A network blip while filing the mirror entry
   * would otherwise drop it silently — the exact failure this whole feature
   * exists to end, one level down.
   */
  pending?: PendingMirror[];
}

interface PendingMirror {
  taskId: string;
  commentId?: string;
  text: string;
  at: string;
}

function read(): Store {
  const r = loadJson<Store>(FILE);
  if (r.status === "ok" && r.data) return r.data;
  if (r.status === "unreadable") {
    // Never rewrite what could not be parsed. An empty store would re-mirror
    // everything and, worse, forget which sections are ours to delete.
    log(`todoist-mirror: ${FILE} is unreadable — mirroring is paused until it is fixed or removed`);
    return { lastSeen: "9999", seen: [], sections: {} };
  }
  return {};
}

function write(s: Store): void {
  if (s.seen && s.seen.length > SEEN_LIMIT) s.seen = s.seen.slice(-SEEN_LIMIT);
  saveJson(FILE, s);
}

/** The mirror project, or undefined when mirroring is switched off. */
export function mirrorProjectId(): string | undefined {
  const id = (process.env.TODOIST_MIRROR_PROJECT ?? "").trim();
  return id || undefined;
}

async function auth(): Promise<Record<string, string> | undefined> {
  const t = await getAccessToken();
  return t ? { authorization: `${t.token_type} ${t.access_token}` } : undefined;
}

interface Section { id: string; name: string }

async function listSections(projectId: string, fetchImpl: typeof fetch): Promise<Section[]> {
  const h = await auth();
  if (!h) return [];
  const res = await fetchImpl(`${API}/sections?project_id=${encodeURIComponent(projectId)}`, { headers: h });
  if (!res.ok) {
    log(`todoist-mirror: sections listing failed with ${res.status}`);
    return [];
  }
  const body = JSON.parse(await res.text()) as { results?: Section[] } | Section[];
  const list = Array.isArray(body) ? body : (body.results ?? []);
  return list.filter((s) => s && s.id).map((s) => ({ id: String(s.id), name: s.name ?? "" }));
}

async function createSection(projectId: string, name: string, fetchImpl: typeof fetch): Promise<string | undefined> {
  const h = await auth();
  if (!h) return undefined;
  const res = await fetchImpl(`${API}/sections`, {
    method: "POST",
    headers: { ...h, "content-type": "application/json" },
    body: JSON.stringify({ project_id: projectId, name }),
  });
  if (!res.ok) {
    log(`todoist-mirror: section create failed with ${res.status}`);
    return undefined;
  }
  const o = JSON.parse(await res.text()) as { id?: string };
  return o.id ? String(o.id) : undefined;
}

async function deleteSection(sectionId: string, fetchImpl: typeof fetch): Promise<boolean> {
  const h = await auth();
  if (!h) return false;
  const res = await fetchImpl(`${API}/sections/${encodeURIComponent(sectionId)}`, { method: "DELETE", headers: h });
  return res.ok;
}

async function activeTaskCount(projectId: string, sectionId: string, fetchImpl: typeof fetch): Promise<number> {
  const h = await auth();
  if (!h) return 1; // Unknown is not empty — never prune on a failed read.
  const res = await fetchImpl(
    `${API}/tasks?project_id=${encodeURIComponent(projectId)}&section_id=${encodeURIComponent(sectionId)}`,
    { headers: h },
  );
  if (!res.ok) return 1;
  const body = JSON.parse(await res.text()) as { results?: unknown[] } | unknown[];
  const list = Array.isArray(body) ? body : (body.results ?? []);
  return list.length;
}

async function createMirrorTask(
  projectId: string,
  sectionId: string | undefined,
  content: string,
  description: string,
  fetchImpl: typeof fetch,
): Promise<string | undefined> {
  const h = await auth();
  if (!h) return undefined;
  const res = await fetchImpl(`${API}/tasks`, {
    method: "POST",
    headers: { ...h, "content-type": "application/json" },
    body: JSON.stringify({
      content,
      description,
      project_id: projectId,
      section_id: sectionId,
      // Due today so it surfaces in Today, which is where the count that
      // actually gets looked at comes from. A mirror nobody opens is the
      // silence this exists to end.
      due_string: "today",
    }),
  });
  if (!res.ok) {
    log(`todoist-mirror: task create failed with ${res.status}: ${(await res.text()).slice(0, 160)}`);
    return undefined;
  }
  const o = JSON.parse(await res.text()) as { id?: string };
  return o.id ? String(o.id) : undefined;
}

/**
 * Post a comment on a task.
 *
 * Unmarked deliberately when mirroring back: see `mirrorBack`. For mirror
 * entries the text is the agent's own and already carries its mark.
 */
async function addComment(taskId: string, content: string, fetchImpl: typeof fetch): Promise<string | undefined> {
  const h = await auth();
  if (!h) return undefined;
  const res = await fetchImpl(`${API}/comments`, {
    method: "POST",
    headers: { ...h, "content-type": "application/json" },
    body: JSON.stringify({ task_id: taskId, content }),
  });
  if (!res.ok) {
    log(`todoist-mirror: comment create failed with ${res.status}`);
    return undefined;
  }
  const o = JSON.parse(await res.text()) as { id?: string };
  return o.id ? String(o.id) : undefined;
}

/** "Claude 🤖 / Home" — the path, because leaf names repeat across the tree. */
function pathOf(projectId: string, tree: Map<string, { id: string; name: string; parentId?: string }>): string {
  const parts: string[] = [];
  let cur = tree.get(projectId);
  let depth = 0;
  while (cur && depth++ < 12) {
    parts.unshift(cur.name || cur.id);
    cur = cur.parentId ? tree.get(cur.parentId) : undefined;
  }
  return parts.length ? parts.join(" / ") : projectId;
}

export interface MirrorResult {
  mirrored: number;
  sectionsCreated: number;
  sectionsRemoved: number;
  skipped: number;
}

/**
 * Only one pass at a time.
 *
 * The daemon runs this on a timer and a session can force it by hand, so two
 * passes overlapping is ordinary, not exotic. Both would list the sections
 * before either created one, and both would then create it — which is how the
 * mirror ended up with two "Claude 🤖 / Home" sections within a minute of being
 * switched on. A second caller joins the pass in flight rather than racing it.
 */
let inFlight: Promise<MirrorResult> | undefined;

/**
 * Mirror everything commented on since the last pass.
 *
 * Safe to call repeatedly: the marker only advances at the end, the seen-set
 * makes a repeated pass a no-op rather than a duplicate, and concurrent callers
 * share one run.
 */
export function syncMirror(fetchImpl: typeof fetch = fetch): Promise<MirrorResult> {
  if (inFlight) return inFlight;
  inFlight = runSync(fetchImpl).finally(() => { inFlight = undefined; });
  return inFlight;
}

async function runSync(fetchImpl: typeof fetch): Promise<MirrorResult> {
  const out: MirrorResult = { mirrored: 0, sectionsCreated: 0, sectionsRemoved: 0, skipped: 0 };
  const mirror = mirrorProjectId();
  if (!mirror) return out;

  const store = read();
  const seen = new Set(store.seen ?? []);
  const sections = { ...(store.sections ?? {}) };

  const records = await fetchCommentActivity(fetchImpl);
  if (records.length === 0) return out;

  // First ever pass: adopt the current position and mirror nothing.
  //
  // Without this, "no marker" means "everything in the activity window is new",
  // and switching the mirror on would file a hundred historical comments as
  // things to deal with today. The mirror is for what arrives from now on; the
  // backlog is what `todoist_inbox` is for.
  if (!store.lastSeen) {
    const newest = records.map((r) => r.event_date).filter(Boolean).sort().pop();
    write({ ...store, lastSeen: newest ?? new Date().toISOString(), seen: [], sections });
    log(`todoist-mirror: initialised at ${newest ?? "now"} — mirroring comments from here on`);
    return out;
  }

  const fresh = records
    .filter((r) => r.event_date && r.parent_item_id)
    .filter((r) => !store.lastSeen || r.event_date! > store.lastSeen)
    .filter((r) => r.parent_project_id !== mirror)
    .filter((r) => {
      const id = (r as { object_id?: string }).object_id;
      return !id || !seen.has(id);
    })
    .sort((a, b) => a.event_date!.localeCompare(b.event_date!));

  if (fresh.length === 0) {
    await prune(mirror, sections, out, fetchImpl);
    write({ ...store, sections });
    return out;
  }

  const batch = fresh.slice(0, MAX_PER_RUN);
  out.skipped = fresh.length - batch.length;

  const tree = await projectTree(fetchImpl);
  const existing = await listSections(mirror, fetchImpl);
  const byName = new Map(existing.map((s) => [s.name, s.id]));

  let newest = store.lastSeen;
  for (const r of batch) {
    const sourceProject = r.parent_project_id ?? "";
    const sectionName = sourceProject ? pathOf(sourceProject, tree) : "Unfiled";

    let sectionId = byName.get(sectionName);
    if (!sectionId) {
      sectionId = await createSection(mirror, sectionName, fetchImpl);
      if (sectionId) {
        byName.set(sectionName, sectionId);
        sections[sectionId] = sourceProject;
        out.sectionsCreated++;
        // Record ownership NOW, not at the end of the pass. A pass that dies
        // between creating a section and writing the store leaves a section
        // nothing claims: prune will never touch it, and the next pass adds a
        // second one beside it. That is exactly what happened on 2026-08-03 —
        // six orphans and three duplicate names from two interrupted runs.
        write({ ...read(), sections });
      }
    }

    const brief = await fetchTaskBrief(r.parent_item_id!, fetchImpl);
    const comment = (r.extra_data?.content ?? "").replace(/\s+/g, " ").trim();
    const title = brief.title ?? `Task ${r.parent_item_id}`;
    const url = brief.url ?? `https://app.todoist.com/app/task/${r.parent_item_id}`;

    const id = await createMirrorTask(
      mirror,
      sectionId,
      `💬 ${title}`.slice(0, 480),
      `${comment.slice(0, 800)}\n\n[Open the task](${url})`,
      fetchImpl,
    );
    if (!id) continue;

    out.mirrored++;
    const commentId = (r as { object_id?: string }).object_id;
    if (commentId) seen.add(commentId);
    if (!newest || r.event_date! > newest) newest = r.event_date!;
  }

  await prune(mirror, sections, out, fetchImpl);
  write({ lastSeen: newest, seen: [...seen], sections });

  audit({
    action: "todoist-mirror", actor: "aibroker", target: `todoist:project:${mirror}`,
    outcome: "synced",
    reason: `${out.mirrored} mirrored, ${out.sectionsCreated} sections added, ${out.sectionsRemoved} removed${out.skipped ? `, ${out.skipped} deferred` : ""}`,
  });
  log(`todoist-mirror: ${out.mirrored} mirrored, +${out.sectionsCreated}/-${out.sectionsRemoved} sections`);
  return out;
}

/**
 * Remove our own sections that have nothing left in them.
 *
 * Only ids we recorded on creation are considered, so a section someone made by
 * hand survives regardless of what it is called. A section that cannot be read
 * counts as non-empty — losing a section is worse than keeping an empty one.
 */
async function prune(
  mirror: string,
  sections: Record<string, string>,
  out: MirrorResult,
  fetchImpl: typeof fetch,
): Promise<void> {
  for (const sectionId of Object.keys(sections)) {
    const n = await activeTaskCount(mirror, sectionId, fetchImpl);
    if (n > 0) continue;
    if (await deleteSection(sectionId, fetchImpl)) {
      delete sections[sectionId];
      out.sectionsRemoved++;
    }
  }
}

// --- the direct path -----------------------------------------------------

/**
 * Mirror a comment we just wrote, without going back to Todoist to find it.
 *
 * This is the primary path, and polling is not the fallback for it — retrying
 * is. The reasoning: Todoist stays silent only about the account's OWN
 * activity, and the bridge writes as the account. Everyone else's comments it
 * already notifies about. So the set of comments that need mirroring is exactly
 * the set we produced, and we know each one at the moment we write it. Reading
 * the activity log to rediscover our own writes was a round trip to learn what
 * we already knew, and it put a five-minute delay on the one case somebody is
 * actually watching.
 *
 * Failures are queued rather than dropped and retried on the next write, so
 * removing the poll does not reintroduce silent loss.
 */
export async function mirrorComment(
  comment: { taskId: string; commentId?: string; text: string },
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const mirror = mirrorProjectId();
  if (!mirror) return false;

  // Anything the mirror project itself accumulates is not news. Without this a
  // comment on a mirror entry would mirror itself, forever.
  const brief = await fetchTaskBrief(comment.taskId, fetchImpl);
  const store = read();

  const queued = [...(store.pending ?? [])];
  const ok = await fileOne(mirror, comment, brief, fetchImpl);
  if (!ok) {
    queued.push({ ...comment, at: new Date().toISOString() });
    write({ ...read(), pending: queued.slice(-50) });
    log(`todoist-mirror: could not file ${comment.taskId} — queued for retry`);
    return false;
  }

  // Retry whatever an earlier failure left behind, now that we know Todoist is
  // answering. Anything still failing stays queued.
  const stillPending: PendingMirror[] = [];
  for (const p of queued) {
    const b = await fetchTaskBrief(p.taskId, fetchImpl);
    if (!(await fileOne(mirror, p, b, fetchImpl))) stillPending.push(p);
  }

  const after = read();
  const seen = new Set(after.seen ?? []);
  if (comment.commentId) seen.add(comment.commentId);
  write({ ...after, seen: [...seen], pending: stillPending });
  return true;
}

async function fileOne(
  mirror: string,
  comment: { taskId: string; text: string },
  brief: { title?: string; url?: string; projectId?: string },
  fetchImpl: typeof fetch,
): Promise<boolean> {
  try {
    const sourceProject = brief.projectId ?? "";
    if (sourceProject === mirror) return true; // Nothing to do, and not an error.

    const tree = await projectTree(fetchImpl);
    const sectionName = sourceProject ? pathOf(sourceProject, tree) : "Unfiled";

    const store = read();
    const sections = { ...(store.sections ?? {}) };
    const existing = await listSections(mirror, fetchImpl);
    let sectionId = existing.find((s) => s.name === sectionName)?.id;
    if (!sectionId) {
      sectionId = await createSection(mirror, sectionName, fetchImpl);
      if (!sectionId) return false;
      sections[sectionId] = sourceProject;
      write({ ...read(), sections });
    }

    const title = brief.title ?? `Task ${comment.taskId}`;
    const url = brief.url ?? `https://app.todoist.com/app/task/${comment.taskId}`;
    const flat = comment.text.replace(/\s+/g, " ").trim();

    // Description carries an EXCERPT and the link, not the comment.
    //
    // A description is a field with a limit and no formatting affordances; a
    // long reply pasted into one is a wall nobody reads and, past the limit, a
    // reply that silently loses its ending. The full text goes where text
    // belongs — a comment on the mirror task — so the entry stays scannable and
    // nothing is truncated where it matters. The link is the anchor the
    // mirror-back path reads to find the source task, so its format is load
    // bearing, not decorative.
    const excerpt = flat.length > 180 ? `${flat.slice(0, 180)}…` : flat;
    const id = await createMirrorTask(
      mirror,
      sectionId,
      `💬 ${title}`.slice(0, 480),
      `${excerpt}\n\n[Open the task](${url})`,
      fetchImpl,
    );
    if (!id) return false;

    // Full text as the first comment. Failing here leaves the entry in place
    // with its excerpt and link — degraded, but not lost, and the link still
    // reaches the real conversation.
    if (flat.length > excerpt.length) {
      // MARKED, and that is not cosmetic. `mirrorBack` carries any unmarked
      // comment on a mirror entry to the source task — that is the whole point
      // of it. This comment IS the source task's comment, already; carrying it
      // back would post a verbatim duplicate onto the conversation it came
      // from. Observed on 2026-08-03: the split landed, and the copy bounced
      // straight back as a second identical reply.
      await addComment(id, `${AGENT_MARK} ${comment.text}`, fetchImpl);
    }
    return true;
  } catch (e) {
    log(`todoist-mirror: file failed — ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

// --- mirror-back ---------------------------------------------------------

/**
 * The source task a mirror entry points at, read from its description link.
 *
 * Stateless on purpose. A stored map would have to survive restarts, stay in
 * step with tasks the user deletes by hand, and be pruned; the link is already
 * in the entry, is the thing the human clicks, and cannot drift out of sync
 * with the entry it belongs to.
 */
export function sourceTaskOf(description: string | undefined): string | undefined {
  const m = /app\.todoist\.com\/app\/task\/([A-Za-z0-9]+)/.exec(description ?? "");
  return m?.[1];
}

/**
 * Carry a comment written on a mirror entry back to the real task.
 *
 * The mirror is where the reader's attention is, so replying there instead of
 * on the source task is not a mistake anyone will stop making — it is the
 * obvious thing to do, and Todoist offers no way to deep-link to an individual
 * comment that would make the source easier to reach than the entry in front of
 * you. So rather than train the human, carry the comment.
 *
 * Loop safety rests on one asymmetry: this writes to the SOURCE task, and the
 * direct mirror path is only ever invoked by `todoist_reply`. Nothing re-reads
 * this write, so there is no cycle to break. Agent-marked comments are ignored
 * regardless, so a session answering inside the mirror cannot bounce either.
 */
export async function mirrorBack(
  ev: { taskId: string; text: string; projectId?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ carried: boolean; reason?: string }> {
  const mirror = mirrorProjectId();
  if (!mirror) return { carried: false, reason: "mirroring is off" };
  if (ev.projectId && ev.projectId !== mirror) return { carried: false, reason: "not a mirror task" };

  // Our own writes are marked; carrying them back would echo a reply into the
  // conversation it came from.
  if (ev.text.trimStart().startsWith(AGENT_MARK)) return { carried: false, reason: "agent comment, ignored" };

  const brief = await fetchTaskBrief(ev.taskId, fetchImpl);
  if (brief.projectId && brief.projectId !== mirror) return { carried: false, reason: "not a mirror task" };

  const source = await sourceFromDescription(ev.taskId, fetchImpl);
  if (!source) return { carried: false, reason: "mirror entry has no source link" };

  const id = await addComment(source, ev.text, fetchImpl);
  if (!id) return { carried: false, reason: "could not post on the source task" };

  audit({
    action: "todoist-mirror", actor: "aibroker", target: `todoist:task:${source}`,
    outcome: "carried-back", reason: `from mirror entry ${ev.taskId}`,
  });
  log(`todoist-mirror: carried a comment from mirror entry ${ev.taskId} back to ${source}`);
  return { carried: true };
}

/** Read a mirror entry's description to find the task it mirrors. */
async function sourceFromDescription(taskId: string, fetchImpl: typeof fetch): Promise<string | undefined> {
  const h = await auth();
  if (!h) return undefined;
  const res = await fetchImpl(`${API}/tasks/${encodeURIComponent(taskId)}`, { headers: h });
  if (!res.ok) return undefined;
  const t = JSON.parse(await res.text()) as { description?: string };
  return sourceTaskOf(t.description);
}
