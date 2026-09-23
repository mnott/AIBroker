/**
 * core/call-timing.ts — per-call-site osascript/ps counters, gated behind
 * AIBROKER_TIMING=1.
 *
 * Diagnostic only, for finding which periodic caller dominates event-loop
 * blocking time. Zero cost when the env var is unset: `timeCall` skips
 * straight to `fn()`, no Date.now(), no Map write.
 */

import { log } from "./log.js";

const stats = new Map<string, { count: number; ms: number }>();
let flushTimerStarted = false;

function ensureFlushTimer(): void {
  if (flushTimerStarted) return;
  flushTimerStarted = true;
  setInterval(() => {
    if (stats.size === 0) return;
    log("[timing] osascript/ps calls in the last 60s:");
    for (const [label, s] of [...stats.entries()].sort((a, b) => b[1].ms - a[1].ms)) {
      log(`[timing]   ${label}: ${s.count} call(s), ${s.ms}ms total`);
    }
    stats.clear();
  }, 60_000).unref();
}

export function timeCall<T>(label: string, fn: () => T): T {
  if (process.env.AIBROKER_TIMING !== "1") return fn();
  ensureFlushTimer();
  const start = Date.now();
  try {
    return fn();
  } finally {
    const ms = Date.now() - start;
    const s = stats.get(label) ?? { count: 0, ms: 0 };
    s.count++;
    s.ms += ms;
    stats.set(label, s);
  }
}
