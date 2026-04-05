/**
 * daemon/trace-log.ts — In-memory ring buffer for message delivery traces.
 *
 * Captures end-to-end message trace events so delivery problems can be
 * diagnosed via the trace_log IPC handler.
 */

const MAX_ENTRIES = 100;

export interface TraceEntry {
  traceId: string;
  timestamp: number;
  event: string;
  sessionId?: string;
  content_preview?: string;
  details?: Record<string, unknown>;
}

const traceBuffer: TraceEntry[] = [];

/**
 * Add a trace entry. Oldest entry is evicted once the buffer exceeds MAX_ENTRIES.
 */
export function addTrace(entry: Omit<TraceEntry, "timestamp">): void {
  traceBuffer.push({ ...entry, timestamp: Date.now() });
  if (traceBuffer.length > MAX_ENTRIES) {
    traceBuffer.shift();
  }
}

/**
 * Return a copy of all trace entries in insertion order (oldest first).
 */
export function getTraces(): TraceEntry[] {
  return [...traceBuffer];
}
