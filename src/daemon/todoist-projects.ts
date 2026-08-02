/**
 * daemon/todoist-projects.ts — the project tree, cached.
 *
 * Needed because ingress can be granted to a subtree: a project that is not
 * itself listed may still be reachable through an ancestor that is. Answering
 * that requires knowing who a project's parent is, which is not in the webhook
 * payload.
 *
 * Cached with a short TTL rather than fetched per event. A webhook arrives in
 * bursts — a task added, a label applied, a comment posted, all within seconds —
 * and one project listing per event is exactly the kind of load that produced
 * the 401 bursts that cost two claims on 2026-08-01.
 *
 * Everything here keys on ID, never on name. Todoist's project search returns
 * nothing for names containing emoji, so "Executive Search 🎯" is invisible to a
 * name query — a resolver that fell back to matching names would silently find
 * no project and report it as absent rather than unsearchable.
 */

import { getAccessToken } from "./todoist-oauth.js";
import { log } from "../core/log.js";

export interface ProjectNode {
  id: string;
  name: string;
  parentId?: string;
}

const TTL_MS = 5 * 60 * 1000;

let cache: { at: number; byId: Map<string, ProjectNode> } | undefined;

/** Drop the cache — used after a grant, and by tests. */
export function invalidateProjectTree(): void {
  cache = undefined;
}

export async function projectTree(fetchImpl: typeof fetch = fetch): Promise<Map<string, ProjectNode>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.byId;

  const token = await getAccessToken();
  if (!token) return cache?.byId ?? new Map();

  try {
    const res = await fetchImpl("https://api.todoist.com/api/v1/projects", {
      headers: { authorization: `${token.token_type} ${token.access_token}` },
    });
    if (!res.ok) throw new Error(`projects listing failed with ${res.status}`);
    const body = JSON.parse(await res.text()) as { results?: unknown[] } | unknown[];
    const list: unknown[] = Array.isArray(body) ? body : (body.results ?? []);

    const byId = new Map<string, ProjectNode>();
    for (const p of list) {
      const o = p as { id?: string; name?: string; parent_id?: string | null; parentId?: string | null };
      if (!o.id) continue;
      byId.set(o.id, {
        id: o.id,
        name: o.name ?? "",
        parentId: o.parent_id ?? o.parentId ?? undefined,
      });
    }
    cache = { at: Date.now(), byId };
    return byId;
  } catch (e) {
    // A stale tree beats no tree: losing it would silently narrow the ingress
    // boundary, and a project dropping out of scope is the failure that looks
    // like "nothing happened".
    log(`todoist-projects: could not refresh the tree — ${e instanceof Error ? e.message : String(e)}`);
    return cache?.byId ?? new Map();
  }
}

/**
 * The chain from a project up to the root, nearest ancestor first.
 *
 * Depth-capped: a cycle in the data would otherwise hang the receiver, and a
 * hung receiver is indistinguishable from a webhook that never arrived.
 */
export function ancestorsOf(projectId: string, tree: Map<string, ProjectNode>, maxDepth = 12): string[] {
  const chain: string[] = [];
  let current = tree.get(projectId)?.parentId;
  const seen = new Set<string>([projectId]);
  while (current && chain.length < maxDepth && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    current = tree.get(current)?.parentId;
  }
  return chain;
}
