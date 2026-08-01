/**
 * daemon/todoist-ingress.ts — granting a project the right to reach a session.
 *
 * The allowlist began as one environment variable of opaque project ids, read
 * once at daemon start. That is the wrong shape for something you change while
 * using the system: creating a Todoist project and then editing a file and
 * restarting a daemon is not a workflow anyone will follow, and a project that
 * looks ready but routes nowhere fails exactly the way this codebase keeps
 * trying to stop things failing — silently, with everything appearing fine.
 *
 * So grants live here too, in a store the daemon re-reads, and every change is
 * an operation with an audit record rather than a file edit. The environment
 * variable still works and still wins nothing: the two are merged, so an
 * existing setup keeps behaving exactly as it did.
 *
 * What does NOT change is that the list stays explicit. A task filed into a
 * project becomes an instruction a session runs with the user's full rights,
 * and Todoist's payload documents that the initiator may be a collaborator on
 * a shared project. Granting ingress must be a decision. It is now a decision
 * that is recorded.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { loadJson, saveJson } from "../core/json-store.js";
import { audit } from "./audit.js";
import { log } from "../core/log.js";
import type { WebhookConfig } from "./todoist-webhook.js";

const FILE = join(homedir(), ".aibroker", "todoist-ingress.json");

export interface IngressGrant {
  projectId: string;
  /** Human-readable, for the CLI and for reading the file a month from now. */
  projectName?: string;
  /** Session that owns work filed here. Unset falls through to the default. */
  owner?: string;
  grantedAt: string;
}

interface Store {
  grants: IngressGrant[];
}

function read(): Store {
  const r = loadJson<Store>(FILE);
  if (r.status === "ok" && Array.isArray(r.data?.grants)) return r.data;
  if (r.status === "unreadable") {
    // Never rewrite a file we could not parse: an ingress list is a security
    // boundary, and silently replacing it with an empty one is worse than
    // refusing to add to it.
    log(`todoist-ingress: ${FILE} is unreadable — grants from it are not in effect`);
  }
  return { grants: [] };
}

export function listGrants(): IngressGrant[] {
  return read().grants;
}

/**
 * Which project belongs to this session.
 *
 * Exists because a session knows itself by its alias — `jobs-matthias` — while
 * the project a human made for it is called `Jobs Matthias`. Asked to file a
 * task "in my project", a session that compares those literally finds nothing
 * and creates a second project named after the alias. Two projects then look
 * like one, work lands in whichever the session picked, and the human watches
 * the other. Ask here instead of guessing from a name.
 *
 * Owner matching folds separators, for the same reason session matching does.
 */
export function projectForOwner(owner: string): IngressGrant | undefined {
  const want = owner.toLowerCase().replace(/[\s_-]+/g, " ").trim();
  return read().grants.find(
    (g) => (g.owner ?? "").toLowerCase().replace(/[\s_-]+/g, " ").trim() === want,
  );
}

/** Grant a project the right to reach a session. Idempotent. */
export function grantIngress(projectId: string, opts: { owner?: string; projectName?: string } = {}): IngressGrant {
  const s = read();
  const existing = s.grants.find((g) => g.projectId === projectId);
  const grant: IngressGrant = existing ?? {
    projectId,
    grantedAt: new Date().toISOString(),
  };
  if (opts.owner !== undefined) grant.owner = opts.owner;
  if (opts.projectName !== undefined) grant.projectName = opts.projectName;
  if (!existing) s.grants.push(grant);
  saveJson(FILE, s);

  audit({
    action: "ingress", actor: "aibroker", target: `todoist:project:${projectId}`,
    outcome: existing ? "updated" : "granted",
    reason: `${opts.projectName ?? projectId} → ${grant.owner ?? "(default owner)"}`,
  });
  log(`todoist-ingress: ${existing ? "updated" : "granted"} ${opts.projectName ?? projectId} → ${grant.owner ?? "default"}`);
  return grant;
}

/** Revoke a grant. Returns whether anything was there to revoke. */
export function revokeIngress(projectId: string): boolean {
  const s = read();
  const before = s.grants.length;
  s.grants = s.grants.filter((g) => g.projectId !== projectId);
  if (s.grants.length === before) return false;
  saveJson(FILE, s);
  audit({
    action: "ingress", actor: "aibroker", target: `todoist:project:${projectId}`,
    outcome: "revoked",
  });
  log(`todoist-ingress: revoked ${projectId}`);
  return true;
}

/**
 * Merge stored grants into a config read from the environment.
 *
 * Called per request rather than at startup: the point of the store is that a
 * grant takes effect when it is made, not when the daemon is next restarted.
 * Returns a new object — the caller's config is never mutated.
 */
export function applyGrants(cfg: WebhookConfig): WebhookConfig {
  const grants = listGrants();
  if (grants.length === 0) return cfg;

  const ids = new Set(cfg.ingressProjectIds);
  const owners = new Map(cfg.projectOwners);
  for (const g of grants) {
    ids.add(g.projectId);
    if (g.owner) owners.set(g.projectId, g.owner);
  }
  return { ...cfg, ingressProjectIds: ids, projectOwners: owners };
}
