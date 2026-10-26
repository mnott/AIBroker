/**
 * daemon/forge-release.ts — a closed issue gives its claim back.
 *
 * Forge issues are the status channel, so they must clean up after themselves:
 * when one is closed, the claim (assignee `claude`, label `in-progress`, the
 * same convention as `pai issue claim|release`) is removed. Nothing is ever
 * closed or reopened here; closing stays a person's word.
 */

import { apiRoot, authHeader } from "./forge-issues.js";
import { parseRepoUrl, type RepoRef } from "./subscribe-issues.js";
import { releaseCredential } from "./forge-credential.js";
import { log } from "../core/log.js";

export const CLAIM_ASSIGNEE = "claude";
export const CLAIM_LABEL = "in-progress";

export interface Release {
  assignees?: string[];
  labelId?: number;
}

/** Minimal forge surface, so tests can fake it. Paths are relative to the repo API root. */
export interface ReleaseClient {
  get(path: string): Promise<any>;
  patch(path: string, body: unknown): Promise<void>;
  del(path: string): Promise<void>;
}

/** The issue number of a closed-issue event, else undefined (other actions and PRs). */
export function closedIssue(payload: any): number | undefined {
  if (payload?.action !== "closed") return undefined;
  const i = payload.issue;
  if (!i || i.pull_request || payload.pull_request) return undefined;
  return typeof i.number === "number" ? i.number : undefined;
}

/** What to release given the issue as the forge holds it now. Empty = nothing to do. */
export function decideRelease(issue: any): Release {
  const out: Release = {};
  const held: string[] = (issue?.assignees ?? []).map((a: any) => a.login);
  if (held.includes(CLAIM_ASSIGNEE)) out.assignees = held.filter((h) => h !== CLAIM_ASSIGNEE);
  const label = (issue?.labels ?? []).find((l: any) => l.name === CLAIM_LABEL);
  if (label) out.labelId = label.id;
  return out;
}

/** Apply the release for a closed-issue event. Returns what was done, for the log. */
export async function releaseClosed(payload: any, client: ReleaseClient): Promise<string | undefined> {
  const n = closedIssue(payload);
  if (n === undefined) return undefined;
  const rel = decideRelease(await client.get(`/issues/${n}`));
  if (!rel.assignees && rel.labelId === undefined) return undefined;
  if (rel.assignees) await client.patch(`/issues/${n}`, { assignees: rel.assignees });
  if (rel.labelId !== undefined) await client.del(`/issues/${n}/labels/${rel.labelId}`);
  return `#${n}: released${rel.assignees ? ` assignee ${CLAIM_ASSIGNEE}` : ""}${rel.labelId !== undefined ? ` label ${CLAIM_LABEL}` : ""}`;
}

function fetchClient(ref: RepoRef, token: string, fetchImpl: typeof fetch): ReleaseClient {
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetchImpl(`${apiRoot(ref)}${path}`, {
      method,
      headers: { authorization: authHeader(token), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.status >= 300) throw new Error(`${method} ${path} → ${res.status}`);
    return res;
  };
  return {
    get: async (p) => (await call("GET", p)).json(),
    patch: async (p, b) => { await call("PATCH", p, b); },
    del: async (p) => { await call("DELETE", p); },
  };
}

/**
 * Webhook entry point, called after the signature check. Never throws.
 * The forge is taken from the payload's repository, which must match the
 * route's own `owner/name` when the route records one.
 */
export async function releaseOnClose(
  routeRepo: string | undefined,
  payload: any,
  token = releaseCredential(),
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  try {
    if (closedIssue(payload) === undefined || !token) return;
    const repo = payload.repository;
    const ref = parseRepoUrl(repo?.html_url ?? "");
    if (!ref || (routeRepo && routeRepo.toLowerCase() !== `${ref.owner}/${ref.repo}`.toLowerCase())) return;
    const done = await releaseClosed(payload, fetchClient(ref, token, fetchImpl));
    if (done) log(`forge-release: ${ref.owner}/${ref.repo} ${done}`);
  } catch (err) {
    log(`forge-release: failed — ${err instanceof Error ? err.message : String(err)}`);
  }
}

// --- echo of the release ---------------------------------------------------

const ECHO_ACTIONS = new Set(["unassigned", "label_updated"]);
const ECHO_WINDOW_MS = 120_000;

interface Seen { at: number; closedAt?: number; labels: string[]; assignees: string[] }
const seen = new Map<string, Seen>();

/**
 * True when the event is the echo of a claim release on a closed issue: only
 * unassigned/label_updated, the issue closed, no claim marker left, and
 * nothing added since the last event the daemon saw for it. The payload
 * carries no diff, so "nothing added" is judged against that memory; with no
 * memory, a `closed` event within 120 s stands in. Every event updates the memory.
 */
export function isClaimReleaseEcho(payload: any, now = Date.now()): boolean {
  const i = payload?.issue;
  const repo = payload?.repository?.full_name;
  if (!i || i.pull_request || payload.pull_request || typeof i.number !== "number") return false;
  const key = `${repo ?? ""}#${i.number}`;
  const labels: string[] = (i.labels ?? []).map((l: any) => l.name);
  const assignees: string[] = (i.assignees ?? []).map((a: any) => a.login);
  const prev = seen.get(key);
  // A close the daemon never saw (dropped earlier, or before it started) is still dated by the payload.
  const stamped = i.state === "closed" ? Date.parse(i.closed_at) : NaN;
  const closedAt = closedIssue(payload) !== undefined ? now : prev?.closedAt ?? (Number.isNaN(stamped) ? undefined : stamped);
  seen.set(key, { at: now, closedAt, labels, assignees });
  for (const [k, v] of seen) if (now - v.at > 3_600_000) seen.delete(k);

  if (i.state !== "closed" || !ECHO_ACTIONS.has(payload.action)) return false;
  if (prev) {
    if (!labels.every((l) => prev.labels.includes(l)) || !assignees.every((a) => prev.assignees.includes(a))) return false;
    const rl = prev.labels.filter((l) => !labels.includes(l));
    const ra = prev.assignees.filter((a) => !assignees.includes(a));
    if (rl.length + ra.length > 0) return rl.every((l) => l === CLAIM_LABEL) && ra.every((a) => a === CLAIM_ASSIGNEE);
  }
  // no diff to judge (no memory, or a repeat): the event must name an absent claim marker within the window
  const marker = payload.action === "unassigned" ? !assignees.includes(CLAIM_ASSIGNEE) : !labels.includes(CLAIM_LABEL);
  return marker && closedAt !== undefined && now - closedAt <= ECHO_WINDOW_MS;
}
