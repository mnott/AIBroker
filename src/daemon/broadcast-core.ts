/**
 * daemon/broadcast-core.ts — one session shouting out to all the others.
 *
 * `aibroker broadcast "<text>" [--ask] [--deadline 2m]` and its MCP twin
 * deliver a message to the mailbox of every live Claude session except the
 * sender, prefixed `[Broadcast:<sender>]`. Delivery is mailbox-only — the same
 * deposit path `send_to_session` uses with `mailboxOnly` — so nothing is ever
 * typed into a busy terminal: a shout about restarting the daemon must not land
 * in whatever the operator or another session is mid-way through typing.
 * Shell tabs are skipped outright: they would execute the message, not read it.
 *
 * With --ask the message carries a broadcast id and invites a short answer;
 * recipients reply with `broadcast reply <id> ok|hold "<reason>"` (or the MCP
 * tool), which lands in the LEDGER — durably, like the watchers — and the
 * sender is notified with ONE summary line into their mailbox when every
 * recipient has answered or the deadline passes (never one message per
 * reply). The sender asks `broadcast status <id>` for the roll-call: per
 * session ok, hold+reason, or no answer. Silence is not agreement by itself —
 * an unanswered ask reads "silent" unless the sender passed --default-ok, in
 * which case it counts as "no objection"; a deadline that has not passed yet
 * says "pending".
 *
 * The store is one JSON file under the state dir (broadcasts.json): every
 * broadcast and every reply is ledgered there durably, and `audit()` records
 * them in the cross-session trail like any other session-to-session action.
 *
 * Pure decisions (who receives, what a status reads) live here; the IPC
 * handlers in core-handlers.ts are thin I/O around them, so the tests can pin
 * the fan-out and the roll-call without a daemon or a terminal.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadJson } from "../core/json-store.js";
import { writePrivate } from "../core/private-file.js";
import { depositToSessionMailbox } from "../core/state.js";
import { stateDir } from "./owner-rename.js";

// ── Types ──

export interface BroadcastRecipient {
  /** The mailbox key the message was deposited under (the pane id). */
  sessionId: string;
  name: string;
}

export interface BroadcastRecord {
  id: string;
  senderId: string;
  senderName: string;
  message: string;
  ask: boolean;
  /** Unix ms after which an unanswered ask is no longer "pending". */
  deadlineAt?: number;
  /** An unanswered ask counts as "no objection" only when the sender said so. */
  defaultOk: boolean;
  createdAt: number;
  recipients: BroadcastRecipient[];
  replies: BroadcastReply[];
  /**
   * The sender's mailbox was told once — the single summary line (all answered
   * or deadline passed). Written with the ledger, so a daemon restart cannot
   * re-notify. Absent = never notified.
   */
  notifiedAt?: number;
}

export interface BroadcastReply {
  sessionId: string;
  name: string;
  answer: "ok" | "hold";
  reason?: string;
  at: number;
}

/** One row of the sender's roll-call. */
export interface BroadcastStatusRow {
  sessionId: string;
  name: string;
  /** ok | hold | silent | no-objection | pending — see statusFor(). */
  status: "ok" | "hold" | "silent" | "no-objection" | "pending";
  reason?: string;
  repliedAt?: number;
}

export interface BroadcastStatus {
  id: string;
  senderName: string;
  message: string;
  ask: boolean;
  defaultOk: boolean;
  createdAt: number;
  deadlineAt?: number;
  deadlinePassed: boolean;
  rows: BroadcastStatusRow[];
  /** The ledger record behind this read — for callers that act on it (summary). */
  record: BroadcastRecord;
}

// ── The message a recipient sees ──

/**
 * The body deposited into each recipient's mailbox. The `[Broadcast:<sender>]`
 * prefix is the routing tag (it joins [Session:], [Keepalive] in the MCP
 * instructions); an ask carries its id and the exact reply command, because a
 * recipient must not have to guess how to answer or what to address it to.
 */
export function composeBroadcastText(senderName: string, message: string, ask?: { id: string; deadlineSec?: number }): string {
  let text = `[Broadcast:${senderName}] ${message}`;
  if (ask) {
    const when = ask.deadlineSec ? `, by ${new Date(Date.now() + ask.deadlineSec * 1000).toISOString()}` : "";
    text += `\n(answers asked — reply: aibroker broadcast reply ${ask.id} ok|hold "<short reason>"${when}; or MCP aibroker_broadcast_reply. Answer briefly; never block on this)`;
  }
  return text;
}

/** The line the SENDER's mailbox gets when someone answers their ask. */
export function composeReplyText(broadcastId: string, name: string, answer: "ok" | "hold", reason?: string): string {
  return `[Broadcast-reply:${broadcastId}] ${name}: ${answer}${reason ? ` — ${reason}` : ""}`;
}

/**
 * The ONE summary line the sender's mailbox gets for an ask — at most once,
 * when every recipient has answered or the deadline passes. Not one message
 * per reply: five "ok" lines are five interruptions that say nothing a single
 * roll-up does not say better.
 */
export function composeSummaryText(b: BroadcastRecord, now: number): string {
  const rows = statusRows(b, now);
  // Counted from the rows, not b.replies: a reply can come from a session no
  // longer in the recipient list — the roll-call is what the sender reads.
  const answered = rows.filter((r) => r.status === "ok" || r.status === "hold").length;
  const why = answered >= b.recipients.length ? "all answered" : "deadline passed";
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  const tally = [...counts].map(([k, n]) => `${n} ${k}`).join(", ");
  const lines = rows
    .filter((r) => r.status === "hold" || r.status === "silent")
    .map((r) => `\n  ${r.status}: ${r.name}${r.reason ? ` — ${r.reason}` : ""}`);
  return `[Broadcast-summary:${b.id}] ${answered}/${b.recipients.length} answered (${why}): ${tally}${lines.join("")}. Roll-call: aibroker broadcast status ${b.id}`;
}

/**
 * The moment this ask's summary is due, if it is due and not yet sent:
 * every recipient answered, or the deadline passed. `undefined` means nothing
 * to report (or already reported) — so callers can fire it after any event
 * (a reply lands, a status is read) without tracking timers.
 */
export function summaryDueAt(b: BroadcastRecord, now: number): number | undefined {
  if (!b.ask || b.notifiedAt !== undefined) return undefined;
  const allAnswered = b.recipients.length > 0 && b.replies.length >= b.recipients.length;
  const deadlinePassed = b.deadlineAt !== undefined && now >= b.deadlineAt;
  return allAnswered || deadlinePassed ? now : undefined;
}

/**
 * Deposit the summary once, durably. The ledger write goes FIRST: a sender
 * who was notified must never be re-notified by a later call (a crash between
 * the two would otherwise spam), while a missed notification is recoverable —
 * the next reply or status read fires it again.
 */
export function notifyBroadcastSummary(b: BroadcastRecord, now: number = Date.now()): boolean {
  const due = summaryDueAt(b, now);
  if (due === undefined) return false;
  const map = loadLedger();
  const cur = map.get(b.id) ?? b;
  if (cur.notifiedAt !== undefined) return false;
  cur.notifiedAt = due;
  saveLedger(map);
  Object.assign(b, cur);
  const keys = [cur.senderId, ...cur.senderId.split("|")];
  for (const k of new Set(keys)) depositToSessionMailbox(k, cur.senderName, composeSummaryText(cur, due));
  return true;
}

// ── Fan-out decision (pure) ──

/**
 * Which sessions receive a broadcast: live Claude panes only, sender excluded.
 *
 * "Live Claude" is the MEASURED flag when present (`isClaude`, from the process
 * table); only an absent measurement falls back to the title heuristic — the
 * same measured-first ranking send_to_session resolves with. A shell is never
 * a recipient: it would execute the message rather than read it, and an ended
 * session's leftover tab matches every name. Worker panes are dropped by the
 * caller before this list is built (listedSessions()).
 */
export function broadcastRecipients(
  snaps: Array<{ id: string; paiName?: string | null; tabTitle?: string | null; name?: string; isClaude?: boolean; attachUuid?: string }>,
  senderId: string | undefined,
): BroadcastRecipient[] {
  const out: BroadcastRecipient[] = [];
  for (const s of snaps) {
    if (s.isClaude === false) continue;
    if (s.isClaude === undefined && !isClaudeRelatedish(s)) continue;
    // Two panes can serve one Claude session (a `claude attach` viewer plus
    // the pane it was started in); the uuid is known only for the viewer, so
    // that is the mailbox key — depositing to the other would never be drained.
    const key = s.attachUuid ? `${s.id}|${s.attachUuid}` : s.id;
    if (senderId && (key === senderId || s.id === senderId)) continue;
    out.push({ sessionId: key, name: s.paiName ?? s.tabTitle ?? s.name ?? s.id });
  }
  return out;
}

/**
 * The title-based guess, used only when the process table gave no answer.
 *
 * `atPrompt` is DERIVED from the process string in the name (a "(node)"
 * foreground = not at a shell prompt), so it is checked FIRST: that is what
 * says "something is running here". The old order consulted tabTitle before
 * the name, and a busy Claude pane's dynamic title ("◑ Work (claude)") does
 * not contain "claude" as a word — every such row read as a shell.
 */
function isClaudeRelatedish(s: { paiName?: string | null; tabTitle?: string | null; name?: string; atPrompt?: boolean }): boolean {
  if (s.paiName) return true;
  if (s.atPrompt === false) return true;
  const text = `${s.tabTitle ?? ""} ${s.name ?? ""}`.toLowerCase();
  return text.includes("claude");
}

// ── Roll-call decision (pure) ──

/**
 * One recipient's row. A reply wins over everything; without one, a non-ask
 * broadcast has nothing to roll-call ("silent" is the only honest word). For
 * an ask: before the deadline it is "pending"; after it, "no-objection" only
 * if the sender opted into --default-ok, else "silent". Silence is never read
 * as agreement unless it was asked to be.
 */
export function statusFor(b: BroadcastRecord, r: BroadcastRecipient, now: number): BroadcastStatusRow {
  const reply = b.replies.find((p) => p.sessionId === r.sessionId);
  if (reply) return { sessionId: r.sessionId, name: r.name, status: reply.answer, reason: reply.reason, repliedAt: reply.at };
  if (!b.ask) return { sessionId: r.sessionId, name: r.name, status: "silent" };
  if (b.deadlineAt === undefined || now < b.deadlineAt) return { sessionId: r.sessionId, name: r.name, status: "pending" };
  return { sessionId: r.sessionId, name: r.name, status: b.defaultOk ? "no-objection" : "silent" };
}

export function statusRows(b: BroadcastRecord, now: number): BroadcastStatusRow[] {
  return b.recipients.map((r) => statusFor(b, r, now));
}

// ── Deadline parsing ──

/** `2m`, `90s`, `1h`, a bare number of seconds → seconds. Null when unparseable. */
export function parseDeadlineSec(spec: string | number | undefined): number | null {
  if (spec === undefined) return null;
  const t = String(spec).trim().toLowerCase();
  const m = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?)?$/.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] ?? "s";
  const sec = Math.round(n * (unit.startsWith("h") ? 3600 : unit.startsWith("m") ? 60 : 1));
  return sec >= 1 && sec <= 86_400 ? sec : null;
}

// ── Ledger store ──

const STORE_FILE = "broadcasts.json";
/** Ledgered asks older than this are dropped on the next write. */
const RETENTION_MS = 7 * 24 * 3600_000;
/** One broadcast id is short and unambiguous enough to type in a reply. */
const ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export function newBroadcastId(): string {
  const bytes = randomBytes(5);
  let s = "";
  for (const b of bytes) s += ID_ALPHABET[b % ID_ALPHABET.length];
  return s;
}

/**
 * The ledger, read fresh on every call and written whole.
 *
 * Read-fresh because the daemon restarts often enough that an in-memory copy
 * would answer `status` about a broadcast created before the restart as if it
 * never existed — exactly when someone is asking where their answers went.
 * Writes are atomic (temp + rename) and 0600: the file holds message bodies.
 * A single hub writes it; a read failure blocks writes rather than
 * substituting an empty ledger over a corrupt file (the json-store contract).
 */
let blocked = false;

function storePath(): string { return join(stateDir(), STORE_FILE); }

/** Filesystem timestamps have ms granularity, so equality is the right test. */
function fileMtimeMs(path: string): number | null {
  try { return existsSync(path) ? statSync(path).mtimeMs : null; } catch { return null; }
}

let cache: Map<string, BroadcastRecord> | null = null;
let cacheMtime: number | null = null;

function loadLedger(): Map<string, BroadcastRecord> {
  const path = storePath();
  const mtime = fileMtimeMs(path);
  if (cache && mtime === cacheMtime) return cache;
  const res = loadJson<Record<string, BroadcastRecord>>(path);
  if (res.status === "unreadable") {
    blocked = true;
    // The caller must not believe an unreadable ledger is an empty one.
    throw new Error(`broadcast ledger exists but cannot be read: ${path} (${res.error}) — nothing was written to it`);
  }
  cache = new Map(Object.entries(res.status === "ok" ? res.data : {}));
  cacheMtime = mtime;
  return cache;
}

function pruneLedger(map: Map<string, BroadcastRecord>, now: number): void {
  for (const [id, b] of map) {
    if (now - b.createdAt > RETENTION_MS) map.delete(id);
  }
}

/**
 * Atomic write with 0600 bits: temp + rename like json-store's saveJson (a
 * reader never sees a partial file), but through writePrivate so the ledger —
 * which holds message bodies — is never left world-readable by a umask.
 */
function saveLedger(map: Map<string, BroadcastRecord>): void {
  if (blocked) throw new Error(`broadcast ledger is blocked from writes (it was unreadable at read) — fix ${storePath()} first`);
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  try {
    writePrivate(tmp, JSON.stringify(Object.fromEntries(map), null, 2));
    renameSync(tmp, path);
    cacheMtime = fileMtimeMs(path);
  } catch (err) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
}

// ── Operations (daemon-side) ──

export interface CreateBroadcastInput {
  senderId: string;
  senderName: string;
  message: string;
  ask: boolean;
  deadlineSec?: number;
  defaultOk: boolean;
  recipients: BroadcastRecipient[];
}

/**
 * Ledger the broadcast and deposit it in every recipient's mailbox.
 *
 * The ledger write comes first: a shout that never reached any mailbox is
 * still a shout that was attempted, and an error after a half-delivered fan-out
 * must not erase the record of what was sent to whom. A deposit into a mailbox
 * that overflowed drops its oldest message; the caller audits that like
 * send_to_session does — here the drop risk is per-recipient and bounded.
 */
export function createBroadcast(input: CreateBroadcastInput, now: number = Date.now()): BroadcastRecord {
  const id = newBroadcastId();
  const askLine = composeBroadcastText(input.senderName, input.message, input.ask ? { id, deadlineSec: input.deadlineSec } : undefined);
  const rec: BroadcastRecord = {
    id,
    senderId: input.senderId,
    senderName: input.senderName,
    message: input.message,
    ask: input.ask,
    ...(input.deadlineSec ? { deadlineAt: now + input.deadlineSec * 1000 } : {}),
    defaultOk: input.defaultOk,
    createdAt: now,
    recipients: input.recipients,
    replies: [],
  };
  const map = loadLedger();
  pruneLedger(map, now);
  map.set(id, rec);
  saveLedger(map);
  for (const r of rec.recipients) {
    depositToSessionMailbox(r.sessionId, input.senderName, askLine);
  }
  return rec;
}

/**
 * Record one answer: into the ledger only. The sender is NOT messaged per
 * reply — `notifyBroadcastSummary` sends them one summary line when all have
 * answered or the deadline passes, and `status` reads the ledger meanwhile.
 * Refuses an unknown id or a recipient who never received the broadcast — a
 * reply to a made-up id must not fabricate a roll-call row.
 */
export function recordBroadcastReply(
  id: string,
  sessionId: string,
  name: string,
  answer: "ok" | "hold",
  reason: string | undefined,
  now: number = Date.now(),
): { ok: true; record: BroadcastRecord } | { ok: false; error: string } {
  const map = loadLedger();
  const b = map.get(id);
  if (!b) return { ok: false, error: `no broadcast with id "${id}" (ids are printed by aibroker broadcast --ask)` };
  if (!b.recipients.some((r) => r.sessionId === sessionId)) {
    return { ok: false, error: `"${id}" was not sent to this session, so its answer is not part of that roll-call` };
  }
  // One answer per session: a later reply replaces an earlier one (changed
  // mind), and the roll-call shows the latest.
  b.replies = b.replies.filter((p) => p.sessionId !== sessionId);
  b.replies.push({ sessionId, name, answer, ...(reason ? { reason } : {}), at: now });
  pruneLedger(map, now);
  saveLedger(map);
  return { ok: true, record: b };
}

export function getBroadcastStatus(id: string, now: number = Date.now()): BroadcastStatus | null {
  const b = loadLedger().get(id);
  if (!b) return null;
  return {
    id: b.id,
    senderName: b.senderName,
    message: b.message,
    ask: b.ask,
    defaultOk: b.defaultOk,
    createdAt: b.createdAt,
    ...(b.deadlineAt !== undefined ? { deadlineAt: b.deadlineAt } : {}),
    deadlinePassed: b.deadlineAt !== undefined && now >= b.deadlineAt,
    rows: statusRows(b, now),
    // The live record too: a handler that must act on it (fire the summary)
    // gets the object without loading the ledger a second time.
    record: b,
  };
}

/** One row per recipient with its answer — the pieces of a status read. */
export function broadcastRollcall(id: string, now: number = Date.now()): { record: BroadcastRecord; rows: BroadcastStatusRow[] } | null {
  const b = loadLedger().get(id);
  if (!b) return null;
  return { record: b, rows: statusRows(b, now) };
}

/** Test seam: point the ledger at a scratch dir and clear the read cache. */
export function _resetLedgerCache(): void {
  cache = null;
  cacheMtime = null;
  blocked = false;
}
