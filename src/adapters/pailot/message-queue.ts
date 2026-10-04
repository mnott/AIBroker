/**
 * adapters/pailot/message-queue.ts — Persistent message queue for PAILot.
 *
 * Circular buffer of content messages (text, voice, image) saved to disk.
 * Each message gets a monotonic sequence number that survives daemon restarts.
 * The app tracks its lastSeq and requests catch_up on reconnect.
 *
 * Only content messages are queued — typing indicators, status updates,
 * session lists, and other ephemeral messages are not persisted.
 */

import { readFileSync, writeFileSync, mkdirSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { log } from "../../core/log.js";
import { saveJson } from "../../core/json-store.js";
import { getAppDir } from "../../core/persistence.js";

const QUEUE_DIR = join(homedir(), ".aibroker");
const QUEUE_FILE = join(QUEUE_DIR, "pailot-queue.json");
const DEFAULT_MAX_SIZE = 500;

/**
 * A byte ceiling, because a count is not a size.
 *
 * The queue held 500 messages and 194 MB of them: three videos at 29.7 MB each,
 * base64, plus a month of screenshots. A client reconnecting asked for
 * everything it had missed, got all of it, wrote it to its own store, and was
 * killed by the watchdog on the next launch trying to parse it.
 *
 * Counting messages bounds nothing when one message can be tens of megabytes.
 */
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

/**
 * The point past which an attachment is not worth replaying.
 *
 * A queue exists so a client that was offline for a while does not lose the
 * thread. Text is what carries the thread; a 30 MB video is not something a
 * reconnecting phone needs handed to it unasked, and it is what breaks the
 * phone when it does. Big payloads are dropped and the caption says so, which
 * leaves the conversation readable and the attachment retrievable on request.
 */
const MAX_PAYLOAD_BYTES = 256 * 1024;

/**
 * Disk ceiling for spilled attachments. The queue's own byte budget counts only
 * the JSON; the bulk lives in files, so it needs a budget of its own or 500
 * entries could pin gigabytes. Oldest attachments expire first.
 */
const MAX_ATTACHMENT_TOTAL_BYTES = 256 * 1024 * 1024;

const OMITTED_NOTE = "[attachment too large to replay — ask for it again if you need it]";

/** Fields that carry bulk. Dropping them leaves the message and its context. */
const BULK_FIELDS = ["imageBase64", "audioBase64", "data"] as const;

/** Content types that get persisted to the queue. */
const CONTENT_TYPES = new Set(["text", "voice", "image"]);

export interface QueuedMessage {
  seq: number;
  sessionId: string;
  type: string;
  payload: Record<string, unknown>;
  ts: number;
}

interface QueueState {
  nextSeq: number;
  messages: QueuedMessage[];
}

// --- Module state ---

let nextSeq = 1;
let messages: QueuedMessage[] = [];
let maxSize = DEFAULT_MAX_SIZE;
let maxBytes = DEFAULT_MAX_BYTES;
let dirty = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

// --- Persistence ---

/** Load the queue from disk. Call once at daemon startup. */
export function loadQueue(maxMessages?: number, maxQueueBytes?: number): void {
  if (maxMessages) maxSize = maxMessages;
  if (maxQueueBytes) maxBytes = maxQueueBytes;

  try {
    mkdirSync(QUEUE_DIR, { recursive: true });
    const raw = readFileSync(QUEUE_FILE, "utf-8");
    const state: QueueState = JSON.parse(raw);

    if (typeof state.nextSeq === "number" && state.nextSeq > 0) {
      nextSeq = state.nextSeq;
    }
    if (Array.isArray(state.messages)) {
      // Trim to maxSize on load (queue file could have been edited)
      messages = state.messages.slice(-maxSize);
      // And to the byte budget: a queue written before this limit existed, or
      // edited by hand, must not survive a restart intact and be replayed.
      messages = messages.map(shrinkIfHuge);
      trimToByteBudget();
      sweepOrphanAttachments();
    }

    log(`[MQ] loaded ${messages.length} messages, nextSeq=${nextSeq}`);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      log("[MQ] no existing queue file — starting fresh");
    } else {
      log(`[MQ] failed to load queue: ${err instanceof Error ? err.message : err}`);
    }
    nextSeq = 1;
    messages = [];
  }
}

/** Save the queue to disk. Debounced to avoid excessive I/O. */
function scheduleSave(): void {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (!dirty) return;
    dirty = false;
    try {
      const state: QueueState = { nextSeq, messages };
      // Atomic, so a crash mid-write cannot truncate the queue into the corrupt
      // state that makes the next load discard it. No .bak: this saves on a
      // 500ms debounce and copying the whole buffer each time would cost more
      // than the backup is worth. Unlike the name and token stores, refusing to
      // save on a corrupt read would be wrong here — undelivered messages are
      // not recoverable from a broken file, so starting fresh IS the correct
      // recovery and blocking writes would disable the queue permanently.
      saveJson(QUEUE_FILE, state, { backup: false });
    } catch (err) {
      log(`[MQ] save error: ${err instanceof Error ? err.message : err}`);
    }
  }, 500); // 500ms debounce — fast enough for reliability, slow enough to batch
}

/** Force an immediate save (call on daemon shutdown). */
export function flushQueue(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  try {
    const state: QueueState = { nextSeq, messages };
    writeFileSync(QUEUE_FILE, JSON.stringify(state), "utf-8");
    log(`[MQ] flushed ${messages.length} messages to disk`);
  } catch (err) {
    log(`[MQ] flush error: ${err instanceof Error ? err.message : err}`);
  }
}

// --- Queue API ---

/**
 * Enqueue a content message. Returns the assigned sequence number.
 * Only call this for content messages (text, voice, image).
 */
export function enqueue(sessionId: string, type: string, payload: Record<string, unknown>): number {
  if (!CONTENT_TYPES.has(type)) return 0;

  const seq = nextSeq++;
  const entry: QueuedMessage = {
    seq,
    sessionId,
    type,
    payload: { ...payload, seq },
    ts: Date.now(),
  };

  messages.push(shrinkIfHuge(entry));

  // Trim circular buffer
  if (messages.length > maxSize) {
    const cut = messages.length - maxSize;
    removeAttachments(messages.slice(0, cut));
    messages = messages.slice(cut);
  }
  trimToByteBudget();
  trimAttachmentBudget();

  scheduleSave();
  return seq;
}

/** Size of an entry as it would be stored and replayed. */
function entryBytes(m: QueuedMessage): number {
  try {
    return JSON.stringify(m).length;
  } catch {
    return 0;
  }
}

/** Reference to a spilled attachment, carried in the queued payload. */
export interface AttachmentRef {
  field: string;
  file: string;
  bytes: number;
}

function attachmentDir(): string {
  return join(getAppDir(), "attachments");
}

function attachmentExt(mimeType: unknown): string {
  const sub = typeof mimeType === "string" ? mimeType.split("/")[1] ?? "" : "";
  return sub.replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase() || "bin";
}

/**
 * Spill the bulk of an oversized entry to disk, keeping a reference.
 *
 * Done at ENQUEUE so the queue file stays small and replay of the JSON is cheap;
 * the attachment itself is handed out separately on catch_up, within bounds
 * (see buildCatchUp). Only images are spilled: audio is never replayed and the
 * transcript carries it. If the write fails the old behaviour applies — the
 * bulk is dropped and the caption says so.
 */
function shrinkIfHuge(m: QueuedMessage): QueuedMessage {
  if (entryBytes(m) <= MAX_PAYLOAD_BYTES) return m;
  const payload = { ...m.payload };
  let dropped = false;
  let ref: AttachmentRef | undefined;
  for (const f of BULK_FIELDS) {
    const v = payload[f];
    if (!v) continue;
    if (m.type === "image" && !ref && typeof v === "string") {
      const file = `${m.seq}.${attachmentExt(payload.mimeType)}`;
      try {
        mkdirSync(attachmentDir(), { recursive: true, mode: 0o700 });
        writeFileSync(join(attachmentDir(), file), v, { encoding: "utf-8", mode: 0o600 });
        ref = { field: f, file, bytes: v.length };
      } catch (err) {
        log(`[MQ] seq=${m.seq} attachment write failed: ${err instanceof Error ? err.message : err}`);
      }
    }
    delete payload[f];
    dropped = true;
  }
  if (!dropped) return m;
  if (ref) {
    payload.attachment = ref;
    log(`[MQ] seq=${m.seq} exceeded ${Math.round(MAX_PAYLOAD_BYTES / 1024)} KB — attachment spilled to ${ref.file}`);
  } else {
    payload.caption = withNote(payload.caption);
    log(`[MQ] seq=${m.seq} exceeded ${Math.round(MAX_PAYLOAD_BYTES / 1024)} KB — stored without its attachment`);
  }
  return { ...m, payload };
}

/** Append the "cannot replay" note to a caption. */
export function withNote(caption: unknown): string {
  const c = typeof caption === "string" ? caption : "";
  return `${c}${c ? " " : ""}${OMITTED_NOTE}`;
}

/** Read a spilled attachment back. Undefined when the file is gone. */
export function readAttachment(ref: AttachmentRef): string | undefined {
  try {
    return readFileSync(join(attachmentDir(), ref.file), "utf-8");
  } catch {
    return undefined;
  }
}

function attachmentOf(m: QueuedMessage): AttachmentRef | undefined {
  const a = m.payload.attachment as AttachmentRef | undefined;
  return a && typeof a.file === "string" ? a : undefined;
}

/** Delete the files of entries leaving the queue, so disk use follows the queue. */
function removeAttachments(gone: QueuedMessage[]): void {
  for (const m of gone) {
    const a = attachmentOf(m);
    if (!a) continue;
    try { unlinkSync(join(attachmentDir(), a.file)); } catch { /* already gone */ }
  }
}

/** Files left by entries the queue no longer holds (crash, hand-edited queue). */
function sweepOrphanAttachments(): void {
  const keep = new Set(messages.map(attachmentOf).filter(Boolean).map((a) => a!.file));
  try {
    for (const f of readdirSync(attachmentDir())) {
      if (!keep.has(f)) { try { unlinkSync(join(attachmentDir(), f)); } catch { /* ignore */ } }
    }
  } catch { /* no directory yet */ }
}

/** Expire the oldest attachments (file only, message stays) past the disk budget. */
function trimAttachmentBudget(): void {
  let total = messages.reduce((n, m) => n + (attachmentOf(m)?.bytes ?? 0), 0);
  for (let i = 0; i < messages.length && total > MAX_ATTACHMENT_TOTAL_BYTES; i++) {
    const a = attachmentOf(messages[i]);
    if (!a) continue;
    removeAttachments([messages[i]]);
    const payload = { ...messages[i].payload };
    delete payload.attachment;
    payload.caption = withNote(payload.caption);
    messages[i] = { ...messages[i], payload };
    total -= a.bytes;
  }
}

/**
 * Drop the oldest messages until the queue fits its byte budget.
 *
 * Oldest first, because the queue's purpose is recent continuity: a client
 * that has been away long enough to need the far end of the buffer has lost
 * the thread regardless.
 */
function trimToByteBudget(): void {
  let total = messages.reduce((n, m) => n + entryBytes(m), 0);
  if (total <= maxBytes) return;
  let dropped = 0;
  while (messages.length > 1 && total > maxBytes) {
    total -= entryBytes(messages[0]);
    removeAttachments([messages[0]]);
    messages.shift();
    dropped++;
  }
  log(`[MQ] byte budget exceeded — dropped ${dropped} oldest message(s), now ${Math.round(total / 1024)} KB`);
}

/**
 * Get all messages with seq > afterSeq.
 * Optionally filter by sessionId (returns all sessions if not specified).
 */
export function getAfter(afterSeq: number, sessionId?: string): QueuedMessage[] {
  return messages.filter(m => {
    if (m.seq <= afterSeq) return false;
    if (sessionId && m.sessionId !== sessionId) return false;
    return true;
  });
}

/** Get the current latest sequence number (nextSeq - 1). */
export function getLatestSeq(): number {
  return nextSeq - 1;
}

/** Check if a message type should be queued. */
export function isContentType(type: string): boolean {
  return CONTENT_TYPES.has(type);
}
