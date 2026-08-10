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

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { log } from "../../core/log.js";
import { saveJson } from "../../core/json-store.js";

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
    messages = messages.slice(-maxSize);
  }
  trimToByteBudget();

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

/**
 * Strip the bulk from an oversized entry, keeping the message itself.
 *
 * Done at ENQUEUE, not at replay: a payload nobody can be handed is not worth
 * carrying on disk either, and stripping once is cheaper than deciding again
 * for every client that reconnects.
 */
function shrinkIfHuge(m: QueuedMessage): QueuedMessage {
  if (entryBytes(m) <= MAX_PAYLOAD_BYTES) return m;
  const payload = { ...m.payload };
  let dropped = false;
  for (const f of BULK_FIELDS) {
    if (payload[f]) { delete payload[f]; dropped = true; }
  }
  if (!dropped) return m;
  const caption = typeof payload.caption === "string" ? payload.caption : "";
  payload.caption = `${caption}${caption ? " " : ""}[attachment too large to replay — ask for it again if you need it]`;
  log(`[MQ] seq=${m.seq} exceeded ${Math.round(MAX_PAYLOAD_BYTES / 1024)} KB — stored without its attachment`);
  return { ...m, payload };
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
