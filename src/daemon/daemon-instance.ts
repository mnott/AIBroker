/**
 * daemon/daemon-instance.ts — one daemon at a time, and a socket that survives
 * having its file deleted from under it.
 *
 * Both halves exist because of 2026-10-21: the running daemon kept answering
 * while /tmp/aibroker.sock was removed from /tmp, so every client failed with
 * "socket not found" for hours while the daemon looked healthy — and `start`
 * happily started a SECOND daemon alongside it, both connected to PAILot.
 *
 * Single instance: the pid file doubles as the lock. A live pid (or a socket
 * that answers) refuses a second start; a dead pid is stale and the lock is
 * taken over. Everything is injected so both paths are testable without a
 * daemon, a socket or launchd.
 */

import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface InstanceDeps {
  pidFile: string;
  socketPath: string;
  /** Read the pid the file names; null when missing or unreadable. */
  readPid: () => number | null;
  /** Is that pid alive? kill(pid, 0) — throws ESRCH when it is not. */
  pidAlive: (pid: number) => boolean;
  /** Does the socket answer? A live daemon whose pid file was lost is still live. */
  socketUp: () => Promise<boolean>;
  /** Remove the stale pid file before taking over. */
  removePidFile: () => void;
  out: (line: string) => void;
}

export function instanceDeps(appDir: string, socketPath: string): InstanceDeps {
  const pidFile = join(appDir, "daemon.pid");
  return {
    pidFile,
    socketPath,
    readPid: () => {
      try {
        const n = Number(readFileSync(pidFile, "utf-8").trim());
        return Number.isInteger(n) && n > 0 ? n : null;
      } catch {
        return null;
      }
    },
    pidAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    socketUp: async () => {
      const { WatcherClient } = await import("../ipc/client.js");
      try {
        await new WatcherClient(socketPath).call_raw("ping", {});
        return true;
      } catch {
        return false;
      }
    },
    removePidFile: () => {
      try {
        unlinkSync(pidFile);
      } catch {
        /* already gone */
      }
    },
    out: (l) => console.log(l),
  };
}

/**
 * Refuse to start a second daemon. Returns the live daemon's pid when one is
 * already running, or -1 when the socket answers but no pid file names one;
 * null when the way is clear — including when the pid file names a dead
 * process, whose stale lock is removed here so this start takes it over.
 */
export async function liveDaemonPid(d: InstanceDeps): Promise<number | null> {
  const pid = d.readPid();
  if (pid !== null && d.pidAlive(pid)) return pid;
  if (pid !== null) {
    d.out(`taking over stale daemon lock (pid ${pid} is not running)`);
    d.removePidFile();
  }
  // The pid file can be missing while a daemon still holds the socket — a hand
  // -started one, or a crash that skipped cleanup. The socket answers for it;
  // the caller gets a refusal, and the pid is unknown (null) rather than a lie.
  if (existsSync(d.socketPath) && (await d.socketUp())) return -1;
  return null;
}

/**
 * The refusal a person reads: names the pid and says what to do instead of
 * starting a second daemon that would double-connect every channel.
 */
export function alreadyRunningMessage(pid: number | null, socketPath: string): string {
  const who = pid !== null && pid > 0 ? `pid ${pid}` : `no pid file, but something answers on ${socketPath}`;
  return `AIBroker daemon is already running (${who}). Use \`aibroker restart\` to restart it, or stop it first with \`aibroker stop\`.`;
}

/**
 * Socket self-heal: the file at socketPath can be deleted from under a healthy
 * listener (a tmp cleaner, a curious hand). Clients then fail with "socket not
 * found" while the daemon looks fine. Every interval, check the path still
 * exists and is the socket this daemon listens on; if not, close and re-listen.
 * Returns the stop function.
 */
export function startSocketGuard(opts: {
  socketPath: string;
  intervalMs: number;
  /** Close the current listener; its close callback removes the socket file. */
  close: (onClosed: () => void) => void;
  /** Re-listen on socketPath. */
  reListen: () => void;
  log: (line: string) => void;
}): () => void {
  const timer = setInterval(() => {
    let ours = false;
    try {
      const st = statSync(opts.socketPath);
      ours = st.isSocket();
    } catch {
      ours = false;
    }
    if (ours) return;
    opts.log("socket file was removed; re-created");
    opts.close(() => opts.reListen());
  }, opts.intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
