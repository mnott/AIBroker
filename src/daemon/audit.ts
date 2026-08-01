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
 * - Bodies are recorded in full. The body IS the "why" — a summary of a message
 *   is exactly the self-report this exists to replace.
 * - Failures and REFUSALS are recorded too. "The hub declined to type this into
 *   a shell" is as much a part of the history as a delivery.
 * - Causation is tracked but honestly labelled. Each session's most recent
 *   inbound message is remembered, and outgoing actions reference it as
 *   `causedBy`. That reconstructs A→B→C chains correctly in the common case and
 *   is a heuristic, not proof: an agent may act for reasons of its own.
 */

import { appendFileSync, mkdirSync, existsSync, statSync, renameSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
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
  /** Full message body, where the action carried one. */
  body?: string;
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

/**
 * Append one event. Never throws: auditing must not be able to break the
 * operation it is recording.
 */
export function audit(e: Omit<AuditEvent, "id" | "ts"> & { id?: string }): string {
  const id = e.id ?? randomUUID().slice(0, 8);
  const event: AuditEvent = {
    id,
    ts: new Date().toISOString(),
    ...e,
    causedBy: e.causedBy ?? lastInbound.get(e.actor),
  };
  try {
    mkdirSync(AUDIT_DIR, { recursive: true });
    rotateIfNeeded();
    appendFileSync(AUDIT_FILE, JSON.stringify(event) + "\n", "utf-8");
  } catch (err) {
    log(`audit: failed to record ${e.action} (${err instanceof Error ? err.message : String(err)})`);
  }
  return id;
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
  if (!existsSync(AUDIT_FILE)) return [];
  let events: AuditEvent[];
  try {
    events = readFileSync(AUDIT_FILE, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => { try { return JSON.parse(l) as AuditEvent; } catch { return null; } })
      .filter((e): e is AuditEvent => e !== null);
  } catch {
    return [];
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
