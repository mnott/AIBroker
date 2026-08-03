/**
 * daemon/outbound.ts — a session reaching into systems we have no connector for.
 *
 * The mirror image of `inbound.ts`, and the more valuable half.
 *
 * Automation platforms are full of hands and empty of judgement: TinyCommand
 * ships 2,023 actions against 414 triggers, and its biggest business
 * integrations — Salesforce, Zoom — have actions only. Their agents run in a
 * cloud with no access to your files, your machine, or you. Ours is the
 * inverse: judgement, local context and a human reachable by voice, with no
 * connector to Stripe or HubSpot and no intention of writing one.
 *
 * So: a session decides, and POSTs `{action, params}` at a webhook the platform
 * already exposes. Their workflow fans it out to whichever of their actions it
 * needs. We never learn an API, never hold a vendor credential, and never
 * maintain a connector — the platform holds all three, which is the one thing
 * it is genuinely good at.
 *
 * The constraints mirror inbound for the same reasons:
 *
 *  - **Targets are named at the terminal, never derived from a payload.** A
 *    session choosing an arbitrary URL is a session with an unbounded egress
 *    channel. Naming one is a decision, and it is recorded.
 *  - **Every call is audited**, request and outcome. An action taken in someone
 *    else's system with no local trace is the worst of both worlds.
 *  - **Secrets are shown once**, on creation, and never by `list`.
 */

import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadJson, saveJson } from "../core/json-store.js";
import { log } from "../core/log.js";
import { audit } from "./audit.js";

const FILE = join(homedir(), ".aibroker", "outbound.json");

/** Refuse a call that takes longer than this. */
const TIMEOUT_MS = 20_000;

/** Calls per target per minute. Generous for decisions, useless for a loop. */
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60_000;

export interface OutboundTarget {
  /** Short name a session calls by. */
  name: string;
  /** Webhook the platform exposes. */
  url: string;
  /** Header name carrying the secret, if the platform wants one. */
  header?: string;
  /** The secret itself. Never printed after creation. */
  secret?: string;
  /** What lives on the other end, for whoever reads this in six months. */
  note?: string;
  enabled?: boolean;
  createdAt: string;
}

interface Store { targets: OutboundTarget[] }

function read(): Store {
  const r = loadJson<Store>(FILE);
  if (r.status === "ok" && Array.isArray(r.data?.targets)) return r.data;
  if (r.status === "unreadable") {
    // A target list we cannot parse is an egress boundary we cannot evaluate.
    // Refusing every call is the only safe reading of "I do not know what is
    // allowed", and rewriting it empty would discard the real one.
    log(`outbound: ${FILE} is unreadable — every call is refused until it is fixed`);
  }
  return { targets: [] };
}

export function listTargets(): OutboundTarget[] {
  return read().targets;
}

export function findTarget(name: string): OutboundTarget | undefined {
  const want = name.trim().toLowerCase();
  return read().targets.find((t) => t.name.toLowerCase() === want);
}

export function addTarget(
  name: string,
  opts: { url: string; header?: string; secret?: string; note?: string },
): OutboundTarget {
  const clean = name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  if (!clean) throw new Error("target name must contain at least one letter or digit");
  if (!/^https:\/\//i.test(opts.url)) {
    // Plain HTTP would put a shared secret and whatever a session decided on
    // the wire in clear. There is no case for it here.
    throw new Error("target URL must be https");
  }

  const s = read();
  const existing = s.targets.find((t) => t.name === clean);
  const target: OutboundTarget = existing ?? {
    name: clean,
    url: opts.url,
    enabled: true,
    createdAt: new Date().toISOString(),
  };
  target.url = opts.url;
  if (opts.header !== undefined) target.header = opts.header;
  if (opts.secret !== undefined) target.secret = opts.secret;
  else if (!existing && opts.header) target.secret = randomBytes(24).toString("base64url");
  if (opts.note !== undefined) target.note = opts.note;
  if (!existing) s.targets.push(target);
  saveJson(FILE, s);

  audit({
    action: "outbound-target", actor: "aibroker", target: `outbound:${clean}`,
    outcome: existing ? "updated" : "created", reason: opts.url,
  });
  log(`outbound: ${existing ? "updated" : "created"} target ${clean} → ${opts.url}`);
  return target;
}

export function removeTarget(name: string): boolean {
  const s = read();
  const before = s.targets.length;
  s.targets = s.targets.filter((t) => t.name !== name.trim().toLowerCase());
  if (s.targets.length === before) return false;
  saveJson(FILE, s);
  audit({ action: "outbound-target", actor: "aibroker", target: `outbound:${name}`, outcome: "removed" });
  log(`outbound: removed target ${name}`);
  return true;
}

const hits = new Map<string, number[]>();

function rateLimited(name: string, now = Date.now()): boolean {
  const w = hits.get(name)?.filter((t) => now - t < RATE_WINDOW_MS) ?? [];
  if (w.length >= RATE_LIMIT) { hits.set(name, w); return true; }
  w.push(now);
  hits.set(name, w);
  return false;
}

export interface OutboundResult {
  ok: boolean;
  status?: number;
  body?: string;
  error?: string;
}

/**
 * Call a named target with an action and its parameters.
 *
 * The body is deliberately dull — `{ action, params, session, at }` — because
 * the shape is a contract with a workflow somebody drew on a canvas, and a
 * contract that changes with the caller's mood is not one. Anything richer
 * belongs inside `params`.
 */
export async function callOutbound(
  name: string,
  action: string,
  params: Record<string, unknown>,
  caller: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OutboundResult> {
  const target = findTarget(name);
  if (!target || target.enabled === false) {
    audit({
      action: "outbound", actor: caller, target: `outbound:${name}`,
      outcome: "refused", reason: target ? "target disabled" : "no such target",
    });
    return { ok: false, error: `no enabled outbound target named "${name}"` };
  }

  if (rateLimited(target.name)) {
    audit({ action: "outbound", actor: caller, target: `outbound:${name}`, outcome: "refused", reason: "rate limited" });
    return { ok: false, error: "rate limited" };
  }

  const headers: Record<string, string> = { "content-type": "application/json" };
  if (target.header && target.secret) headers[target.header] = target.secret;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(target.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ action, params, session: caller, at: new Date().toISOString() }),
      signal: ac.signal,
    });
    const body = (await res.text()).slice(0, 2000);

    // Recorded whether it worked or not. An action taken in someone else's
    // system with no trace here is the worst of both worlds: it happened, and
    // nothing local can say so.
    audit({
      action: "outbound", actor: caller, target: `outbound:${target.name}`,
      outcome: res.ok ? "sent" : "failed",
      reason: `${action} → ${res.status}`,
      body: JSON.stringify(params).slice(0, 2000),
    });
    log(`outbound: ${caller} → ${target.name}.${action} → ${res.status}`);
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    audit({
      action: "outbound", actor: caller, target: `outbound:${target.name}`,
      outcome: "failed", reason: `${action} — ${error}`,
    });
    return { ok: false, error };
  } finally {
    clearTimeout(timer);
  }
}
