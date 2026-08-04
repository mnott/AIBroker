/**
 * daemon/audit.ts — append-only record of what one session did to another.
 *
 * Cross-session action is now routine: a session can message another, dispatch
 * work to it, probe it, launch a new one, or rename it. Chains form that nobody
 * designed — an observation in one project reached a second session, which
 * relayed it to a third that happened to be fixing exactly that defect. Useful,
 * and entirely unplanned.
 *
 * The problem is that today the only record of any of it is each participant's
 * own account. A session that acts on another and does not mention it leaves no
 * trace; a session that ends takes its side of the story with it. "Why did work
 * happen in a project nobody had touched for two weeks" was answerable only
 * because the agent involved chose to say so. That is self-report, not audit.
 *
 * So: every daemon-mediated cross-session action is appended here as one JSON
 * object per line, before and independently of whatever the actor later says
 * about it.
 *
 * Design notes:
 *
 * - JSONL, not a database. Greppable with the tools already on the machine,
 *   appendable by anything (other agents and MCP servers can write their own
 *   events into the same file), and a truncated final line costs one record
 *   rather than the file.
 * - Bodies are kept whole, inline when small and in a content-addressed
 *   sidecar when not. The body IS the "why" — a summary of a message is
 *   exactly the self-report this exists to replace — but a multi-KB line
 *   cannot be appended atomically, so the text moves out and a hash stays in.
 * - Failures and REFUSALS are recorded too. "The hub declined to type this into
 *   a shell" is as much a part of the history as a delivery.
 * - Causation is tracked but honestly labelled. Each actor's most recent
 *   inbound message is remembered, and outgoing actions reference it as
 *   `causedBy`. That reconstructs A→B→C chains correctly in the common case and
 *   is a heuristic, not proof: an agent may act for reasons of its own.
 */

import {
  appendFileSync, mkdirSync, existsSync, statSync, renameSync, readFileSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { log } from "../core/log.js";

/**
 * Overridable so tests never append to the real trail. An audit log polluted
 * with fixtures is one you stop trusting, which defeats the purpose.
 */
const AUDIT_FILE = process.env.AIBROKER_AUDIT_FILE
  ?? join(homedir(), ".aibroker", "audit.jsonl");
const AUDIT_DIR = dirname(AUDIT_FILE);
/** Rotate past this so the live file stays greppable. */
const MAX_BYTES = 32 * 1024 * 1024;

/**
 * ── Multi-writer contract ───────────────────────────────────────────────────
 *
 * This file is designed to have more than one producer appending to it (the
 * hub, PAI's task bus, anything else worth recording). Three rules make that
 * safe, and all three are properties of the FORMAT rather than of each
 * writer's discipline — a convention only one side remembers is not a format.
 *
 * 1. LINES STAY SMALL. An O_APPEND write is only atomic up to a modest kernel
 *    limit (PIPE_BUF is 512 bytes on macOS); beyond that two writers can
 *    interleave mid-line and corrupt the file. Since bodies are the whole
 *    point and routinely run to several KB — real lines here already reached
 *    3.5KB with a single writer — anything over INLINE_BODY_MAX is spilled to
 *    a content-addressed sidecar and referenced by hash. Lines stay bounded no
 *    matter how large the payload or how many writers arrive.
 *
 * 2. IDS ARE NAMESPACED AND SORTABLE. `<ns>-<base36 ms>-<base36 random>`, e.g.
 *    `ab-m5x9k2p-7f3q2a`. The namespace prevents collisions between producers,
 *    the timestamp makes the file sort chronologically, and the shape is
 *    trivial to reimplement in any language — which matters, because
 *    `causedBy` only chains across writers if their ids are mutually
 *    recognisable.
 *
 * 3. ACTORS ARE NAMESPACED. `<producer>:<component>` — `aibroker:hub`,
 *    `session:Youdrill`, `pai:task-bus`, `todoist:someone@example.com`. Bare
 *    names would collide across producers and quietly degrade the causation
 *    heuristic, and a heuristic that degrades silently is harder to distrust
 *    correctly than one that fails loudly.
 */

/** This producer's id namespace. Other writers use their own. */
export const AUDIT_NS = "ab";
/** Bodies longer than this are spilled to a sidecar so lines stay small. */
export const INLINE_BODY_MAX = 700;

/** Generate an event id. See rule 2 above; other producers replicate this shape. */
export function newAuditId(ns = AUDIT_NS): string {
  const t = Date.now().toString(36);
  const r = Math.floor(Math.random() * 36 ** 6).toString(36).padStart(6, "0");
  return `${ns}-${t}-${r}`;
}

export interface AuditEvent {
  /** Unique id for this event; referenced by `causedBy` on downstream events. */
  id: string;
  ts: string;
  /** What happened: send | dispatch | ask | launch | rename | refuse. */
  action: string;
  /** Who acted. Session label where known, else the raw caller id. */
  actor: string;
  /** What was acted upon. */
  target: string;
  /** delivered | spawned | refused | failed | … — verbatim from the operation. */
  outcome: string;
  /**
   * The message body. Held inline when short; otherwise this is a preview and
   * the full text lives in the sidecar named by `bodyRef`.
   */
  body?: string;
  /** sha256 of the full body, present only when it was spilled to a sidecar. */
  bodyRef?: string;
  /** Length of the full body in bytes, so a truncated preview is obvious. */
  bodyBytes?: number;
  /** Why it failed or was refused. */
  reason?: string;
  /** The inbound event this actor was most recently handed. Heuristic. */
  causedBy?: string;
  /** Anything action-specific. */
  meta?: Record<string, unknown>;
}

/** actor -> id of the last message delivered TO them, for causation chaining. */
const lastInbound = new Map<string, string>();

function rotateIfNeeded(): void {
  try {
    if (existsSync(AUDIT_FILE) && statSync(AUDIT_FILE).size > MAX_BYTES) {
      renameSync(AUDIT_FILE, `${AUDIT_FILE}.1`);
    }
  } catch { /* rotation is best effort; never block the write */ }
}

/** Directory holding spilled bodies, one file per distinct content hash. */
function bodyDir(): string { return join(AUDIT_DIR, "audit-bodies"); }

/**
 * Move an oversized body out of the line and into a content-addressed file.
 *
 * Content addressing means an identical body written twice — a retried
 * dispatch, the same task relayed onward — costs one file, and the hash in the
 * line is itself proof of what was recorded.
 */
function spillBody(body: string): { preview: string; ref: string; bytes: number } {
  const bytes = Buffer.byteLength(body, "utf-8");
  const ref = createHash("sha256").update(body).digest("hex");
  try {
    mkdirSync(bodyDir(), { recursive: true });
    const p = join(bodyDir(), `${ref}.txt`);
    if (!existsSync(p)) writeFileSync(p, body, "utf-8");
  } catch (err) {
    log(`audit: could not spill body ${ref.slice(0, 12)} (${err instanceof Error ? err.message : String(err)})`);
  }
  return { preview: body.slice(0, INLINE_BODY_MAX), ref, bytes };
}

/**
 * Append one event. Never throws: auditing must not be able to break the
 * operation it is recording.
 */
export function audit(e: Omit<AuditEvent, "id" | "ts"> & { id?: string }): string {
  const id = e.id ?? newAuditId();

  const event: AuditEvent = {
    id,
    ts: new Date().toISOString(),
    ...e,
    causedBy: e.causedBy ?? lastInbound.get(e.actor),
  };

  // Keep the line small so concurrent appends cannot interleave. See the
  // multi-writer contract above.
  if (event.body && event.body.length > INLINE_BODY_MAX) {
    const { preview, ref, bytes } = spillBody(event.body);
    event.body = preview;
    event.bodyRef = ref;
    event.bodyBytes = bytes;
  }
  // `meta` is free-form and can carry a long reply; bound it too.
  if (event.meta && typeof event.meta.reply === "string" && event.meta.reply.length > INLINE_BODY_MAX) {
    event.meta = { ...event.meta, reply: `${event.meta.reply.slice(0, INLINE_BODY_MAX)}…` };
  }

  try {
    mkdirSync(AUDIT_DIR, { recursive: true });
    rotateIfNeeded();
    appendFileSync(AUDIT_FILE, JSON.stringify(event) + "\n", "utf-8");
  } catch (err) {
    log(`audit: failed to record ${e.action} (${err instanceof Error ? err.message : String(err)})`);
  }
  return id;
}

/** The full body of an event: inline text, or the sidecar it points at. */
export function resolveBody(e: AuditEvent): string | undefined {
  if (!e.bodyRef) return e.body;
  try {
    return readFileSync(join(bodyDir(), `${e.bodyRef}.txt`), "utf-8");
  } catch {
    // The sidecar is gone; the preview is still better than nothing, and
    // saying so beats silently returning a truncated body as if it were whole.
    return e.body ? `${e.body}\n[… full body unavailable: sidecar ${e.bodyRef.slice(0, 12)} missing]` : undefined;
  }
}

/**
 * Note that `target` has just been handed something, so their next outgoing
 * action can be attributed to it. This is what turns isolated events into a
 * chain.
 */
export function noteInbound(target: string, eventId: string): void {
  if (target) lastInbound.set(target, eventId);
}

export interface AuditQuery {
  /** Only events where this string is the actor or the target. */
  session?: string;
  /** Only this action type. */
  action?: string;
  /** Follow a causation chain from this event id, in both directions. */
  trace?: string;
  /** ISO timestamp lower bound. */
  since?: string;
  limit?: number;
}

export function readAudit(q: AuditQuery = {}): AuditEvent[] {
  // No file at all genuinely means no events, and [] is the honest answer.
  if (!existsSync(AUDIT_FILE)) return [];

  let events: AuditEvent[];
  try {
    events = readFileSync(AUDIT_FILE, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => { try { return JSON.parse(l) as AuditEvent; } catch { return null; } })
      .filter((e): e is AuditEvent => e !== null);
  } catch (e) {
    // A file that EXISTS and cannot be read is not an empty audit log, and
    // returning [] made the two byte-identical to every caller. PAI shipped the
    // same shape in its Postgres search on 2026-08-04: a dead container made
    // memory_search answer "No results found", another session believed it, and
    // told Matthias a fact that was not true. Nothing in the response could have
    // revealed it. An unreadable log is louder than a quiet lie.
    throw new Error(
      `Audit log exists but could not be read: ${AUDIT_FILE}\n` +
        `  This is NOT an empty audit log — the file is there and unreadable.\n` +
        `  ${e instanceof Error ? e.message : String(e)}`
    );
  }

  if (q.trace) {
    // Walk the chain both ways: what led here, and what this led to.
    const byId = new Map(events.map((e) => [e.id, e]));
    const keep = new Set<string>();

    let cur = byId.get(q.trace);
    while (cur) { keep.add(cur.id); cur = cur.causedBy ? byId.get(cur.causedBy) : undefined; }

    let grew = true;
    while (grew) {
      grew = false;
      for (const e of events) {
        if (e.causedBy && keep.has(e.causedBy) && !keep.has(e.id)) { keep.add(e.id); grew = true; }
      }
    }
    events = events.filter((e) => keep.has(e.id));
  }

  const lower = q.session?.toLowerCase();
  events = events.filter((e) => {
    if (q.action && e.action !== q.action) return false;
    if (q.since && e.ts < q.since) return false;
    if (lower && !e.actor.toLowerCase().includes(lower) && !e.target.toLowerCase().includes(lower)) return false;
    return true;
  });

  return q.limit ? events.slice(-q.limit) : events;
}

export function auditPath(): string { return AUDIT_FILE; }
