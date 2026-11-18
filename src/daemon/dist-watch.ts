/**
 * daemon/dist-watch.ts — self-restart the daemon when dist changes under it.
 *
 * `pai worker merge` in this repo rebuilds dist but does not restart the
 * AIBroker daemon (unlike PAI, whose gate does). On 2026-11-18 that meant a
 * fix merged on 2026-11-16 was still not live two days later: the daemon ran
 * the dist built at its start (17 Nov 02:28) while newer fixes sat in the
 * checkout, and morning mail kept failing for a cause already fixed. The fix
 * is to make a new build impossible to miss, as PAI's dist-watch does: the
 * watcher polls the entry file's whole-microsecond mtime plus size (the build
 * id); once it differs from the id this process started on and has held for
 * the debounce (a build writes many files), the daemon SIGTERMs itself — the
 * existing shutdown path flushes and cleans up, and launchd (KeepAlive) starts
 * the new build.
 */

import { statSync } from "node:fs";
import { log } from "../core/log.js";

/** A build writes many files; dist must hold the same id this long before we act. */
export const DIST_STABLE_MS = 10_000;
export const DIST_POLL_MS = 5_000;

/**
 * The build id of a dist entry file: raw whole-µs mtime + size.
 * `Math.round(mtimeMs)` misses same-millisecond rebuilds (PAI hit this on
 * 2026-11-16); two builds in one ms differ by at least a byte, and a re-emitted
 * identical build needs no restart anyway. Undefined when unreadable (mid-build).
 */
export function distBuildId(entry: string): string | undefined {
  try {
    const st = statSync(entry);
    return `${Math.round(st.mtimeMs * 1000)}:${st.size}`;
  } catch {
    return undefined;
  }
}

export interface DistWatchDeps {
  /** Current build id of dist (entry file mtime + size), undefined when unreadable (mid-build). */
  readId: () => string | undefined;
  now: () => number;
  restart: (reason: string) => void;
  log: (line: string) => void;
}

/** Returns a tick to run on a timer; fires `restart` at most once per distinct new id. */
export function createDistWatch(d: DistWatchDeps, startId: string | undefined = d.readId()): () => "idle" | "settling" | "restarting" {
  let seen: string | undefined;
  let since = 0;
  let fired = false;
  return () => {
    const now = d.now();
    const id = d.readId();
    if (id === undefined || startId === undefined || id === startId) {
      // No readable change, or the entry is back on our own build: forget any
      // pending settle and re-arm, so a failed restart that came back on the
      // old build still watches for the next one.
      seen = undefined;
      fired = false;
      return "idle";
    }
    if (fired) return "restarting";
    if (id !== seen) {
      seen = id;
      since = now; // only a NEW id restarts the settle clock
      return "settling";
    }
    if (now - since < DIST_STABLE_MS) return "settling";
    fired = true;
    d.restart(`dist changed (${startId} -> ${id}), stable ${Math.round((now - since) / 1000)}s`);
    return "restarting";
  };
}

/** The daemon's own entry file (dist/daemon/cli.js when running from dist). */
export function daemonEntryPath(): string {
  return process.argv[1] ?? "";
}

/** Poll the build id; restart on a settled change. Called once at daemon start. */
export function startDistWatch(): void {
  const entry = daemonEntryPath();
  // A dev run (`tsx src/...`) has no dist to watch; only the built daemon self-restarts.
  if (!entry.endsWith(".js") || !entry.includes("dist")) return;
  const tick = createDistWatch({
    readId: () => distBuildId(entry),
    now: Date.now,
    restart: (reason) => {
      log(`dist-watch: ${reason} — restarting to pick up the new build`);
      // Graceful: the daemon's SIGTERM handler flushes held groups and frees the
      // socket; launchd (KeepAlive) starts the freshly built entry.
      process.kill(process.pid, "SIGTERM");
    },
    log: (l) => log(l),
  });
  const timer = setInterval(tick, DIST_POLL_MS);
  timer.unref?.();
}
