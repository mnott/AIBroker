/** Voice note batching: transcripts arriving within the window are joined into one flush. */

export const DEFAULT_VOICE_BATCH_MS = 800;

export function voiceBatchWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.AIBROKER_VOICE_BATCH_MS);
  return env.AIBROKER_VOICE_BATCH_MS !== undefined && Number.isFinite(n) && n >= 0 ? n : DEFAULT_VOICE_BATCH_MS;
}

export interface VoiceBatcher {
  add(transcript: string): void;
  /** Flush now (no-op when empty). */
  flush(): void;
}

export function createVoiceBatcher(
  onFlush: (transcripts: string[]) => void,
  windowMs: () => number = voiceBatchWindowMs,
): VoiceBatcher {
  let items: string[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = (): void => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (items.length === 0) return;
    const out = items;
    items = [];
    onFlush(out);
  };
  return {
    add(t) {
      items.push(t);
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, windowMs());
    },
    flush,
  };
}
