/**
 * core/event-loop-lag.ts — say out loud when the event loop stops turning.
 *
 * On 2026-11-17 the daemon froze: 0 % CPU, log silent, IPC and `mailbox wait`
 * hung, and it took a launchctl kickstart to recover. The log showed an MQTT
 * keep-alive timeout BEFORE and BETWEEN six "osascript TIMED OUT after 30000ms"
 * lines — the loop was blocked for ~30 s stretches, and nothing in the log said
 * so. A blocked loop cannot log its own blockage from inside the block; this is
 * the witness that runs afterwards.
 *
 * monitorEventLoopDelay measures the gap between successive timer callbacks:
 * a synchronous 30 s spawnSync shows as one ~30 s histogram sample even though
 * no JS ran to record it. Checked once a second against max (not mean or p99):
 * a single blocking call is exactly what stalls MQTT keep-alives and IPC, and a
 * mean would wash one 30 s stall across 60 samples into noise.
 */

import { monitorEventLoopDelay } from "node:perf_hooks";
import { log } from "./log.js";

/** Report when the worst gap since the last check exceeds this. */
export const EVENT_LOOP_LAG_THRESHOLD_MS = 1_000;
const CHECK_INTERVAL_MS = 1_000;

let started = false;

/**
 * Start watching (once per process). Returns the reset function for tests and
 * shutdown; calling it twice is a no-op, so daemon restart paths cannot stack
 * watchers.
 */
export function startLagMonitor(
  intervalMs = CHECK_INTERVAL_MS,
  thresholdMs = EVENT_LOOP_LAG_THRESHOLD_MS,
): () => void {
  if (started) return () => {};
  started = true;

  // resolution default (~20ms) is fine: sub-threshold gaps are not the story.
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  let prevMax = 0;

  const timer = setInterval(() => {
    // nanoseconds → ms. max resets on every read, so this reports the worst
    // gap SINCE THE LAST CHECK: one stall is logged once, a recurring stall
    // every second it recurs.
    const maxMs = histogram.max / 1e6;
    if (maxMs > thresholdMs && maxMs > prevMax) {
      log(`event loop blocked ${Math.round(maxMs)} ms — timers, IPC and MQTT keep-alives stalled for that long`);
    }
    prevMax = maxMs;
  }, intervalMs);
  timer.unref?.();

  return () => {
    clearInterval(timer);
    histogram.disable();
    started = false;
  };
}
