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

const QUEUE_DIR = join(homedir(), ".aibroker");
const QUEUE_FILE = join(QUEUE_DIR, "pailot-queue.json");
const DEFAULT_MAX_SIZE = 500;

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
let dirty = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

// --- Persistence ---

/** Load the queue from disk. Call once at daemon startup. */
export function loadQueue(maxMessages?: number): void {
  if (maxMessages) maxSize = maxMessages;

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
      writeFileSync(QUEUE_FILE, JSON.stringify(state), "utf-8");
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

  messages.push(entry);

  // Trim circular buffer
  if (messages.length > maxSize) {
    messages = messages.slice(-maxSize);
  }

  scheduleSave();
  return seq;
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
