/**
 * daemon/daemon-control.ts — `aibroker stop` / `aibroker restart` without lsof.
 *
 * Order, most cooperative first:
 *   1. an installed AND active service (systemd user unit / launchd agent) is
 *      driven through its own manager — killing the process behind its back
 *      would only make the manager start it again;
 *   2. otherwise ask the daemon to shut itself down over IPC (`shutdown`);
 *   3. otherwise signal the pid in ~/.aibroker/daemon.pid, written at start.
 *
 * Everything the steps touch is injected so the order is testable without a
 * daemon, systemctl or launchctl.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { WatcherClient } from "../ipc/client.js";

export const SYSTEMD_UNIT = "aibroker.service";
export const LAUNCHD_LABEL = "com.aibroker.daemon";

export interface ControlDeps {
  platform: NodeJS.Platform;
  home: string;
  uid: number;
  exists: (path: string) => boolean;
  /** Run a command; status is null when it could not be started. */
  exec: (cmd: string, args: string[]) => { status: number | null; stdout: string };
  /** Ask the daemon to shut down; rejects when it is unreachable. */
  ipcShutdown: () => Promise<void>;
  /** Is anything answering on the daemon socket? */
  socketUp: () => Promise<boolean>;
  readPid: () => number | null;
  kill: (pid: number, signal: NodeJS.Signals | 0) => void;
  sleep: (ms: number) => Promise<void>;
  /** Start a detached foreground daemon (restart without a service). */
  spawnDaemon: () => void;
  out: (line: string) => void;
}

export type StopVia = "service" | "ipc" | "pidfile";

export function pidFilePath(home: string = homedir()): string {
  return join(home, ".aibroker", "daemon.pid");
}

export function servicePaths(home: string): { systemd: string; launchd: string } {
  return {
    systemd: join(home, ".config", "systemd", "user", SYSTEMD_UNIT),
    launchd: join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`),
  };
}

/** The installed service manager entry, when there is one and it is running. */
function activeService(d: ControlDeps): "systemd" | "launchd" | null {
  const paths = servicePaths(d.home);
  if (d.platform === "darwin") {
    if (!d.exists(paths.launchd)) return null;
    return d.exec("launchctl", ["print", `gui/${d.uid}/${LAUNCHD_LABEL}`]).status === 0 ? "launchd" : null;
  }
  if (!d.exists(paths.systemd)) return null;
  return d.exec("systemctl", ["--user", "is-active", "--quiet", SYSTEMD_UNIT]).status === 0 ? "systemd" : null;
}

async function waitDown(d: ControlDeps, ms = 5_000): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 100) {
    if (!(await d.socketUp())) return true;
    await d.sleep(100);
  }
  return false;
}

/** Stop the daemon; returns which step did it. Throws when nothing was running. */
export async function stopDaemon(d: ControlDeps): Promise<StopVia> {
  const svc = activeService(d);
  if (svc === "systemd") {
    const r = d.exec("systemctl", ["--user", "stop", SYSTEMD_UNIT]);
    if (r.status !== 0) throw new Error(`systemctl --user stop ${SYSTEMD_UNIT} failed`);
    d.out(`Stopped ${SYSTEMD_UNIT}`);
    return "service";
  }
  if (svc === "launchd") {
    const r = d.exec("launchctl", ["bootout", `gui/${d.uid}/${LAUNCHD_LABEL}`]);
    if (r.status !== 0) throw new Error(`launchctl bootout ${LAUNCHD_LABEL} failed`);
    d.out(`Stopped ${LAUNCHD_LABEL}`);
    return "service";
  }

  try {
    await d.ipcShutdown();
    if (await waitDown(d)) {
      d.out("Asked the daemon to shut down; it did");
      return "ipc";
    }
  } catch {
    // unreachable: fall through to the pidfile
  }

  const pid = d.readPid();
  if (pid !== null) {
    try {
      d.kill(pid, 0); // is that pid alive at all?
      d.kill(pid, "SIGTERM");
      d.out(`Sent SIGTERM to daemon (PID ${pid}, from ${pidFilePath(d.home)})`);
      return "pidfile";
    } catch {
      /* stale pidfile */
    }
  }
  throw new Error("Daemon not running (no service, no answer on the socket, no live pid in daemon.pid)");
}

/** Restart: the service manager restarts its own unit; otherwise stop, then start detached. */
export async function restartDaemon(d: ControlDeps): Promise<StopVia | "started"> {
  const svc = activeService(d);
  if (svc === "systemd") {
    if (d.exec("systemctl", ["--user", "restart", SYSTEMD_UNIT]).status !== 0) {
      throw new Error(`systemctl --user restart ${SYSTEMD_UNIT} failed`);
    }
    d.out(`Restarted ${SYSTEMD_UNIT}`);
    return "service";
  }
  if (svc === "launchd") {
    if (d.exec("launchctl", ["kickstart", "-k", `gui/${d.uid}/${LAUNCHD_LABEL}`]).status !== 0) {
      throw new Error(`launchctl kickstart ${LAUNCHD_LABEL} failed`);
    }
    d.out(`Restarted ${LAUNCHD_LABEL}`);
    return "service";
  }
  try { await stopDaemon(d); } catch { /* nothing was running: restart is then a plain start */ }
  await waitDown(d);
  d.spawnDaemon();
  d.out("Started the daemon");
  return "started";
}

async function ipc(method: string): Promise<void> {
  const { DAEMON_SOCKET_PATH } = await import("./index.js");
  await new WatcherClient(DAEMON_SOCKET_PATH).call_raw(method, {});
}

export function liveControlDeps(): ControlDeps {
  const home = homedir();
  return {
    platform: process.platform,
    home,
    uid: process.getuid?.() ?? 0,
    exists: existsSync,
    exec: (cmd, args) => {
      const r = spawnSync(cmd, args, { encoding: "utf8" });
      return { status: r.status, stdout: r.stdout ?? "" };
    },
    ipcShutdown: () => ipc("shutdown"),
    socketUp: async () => {
      try { await ipc("ping"); return true; } catch { return false; }
    },
    readPid: () => {
      try {
        const n = Number(readFileSync(pidFilePath(home), "utf8").trim());
        return Number.isInteger(n) && n > 0 ? n : null;
      } catch { return null; }
    },
    kill: (pid, sig) => { process.kill(pid, sig); },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    spawnDaemon: () => {
      mkdirSync(join(home, ".aibroker"), { recursive: true });
      const log = openSync(join(home, ".aibroker", "daemon.log"), "a", 0o600);
      spawn(process.execPath, [process.argv[1], "start"], { detached: true, stdio: ["ignore", log, log] }).unref();
    },
    out: (l) => console.log(l),
  };
}

export async function runStopRestart(verb: "stop" | "restart"): Promise<void> {
  const d = liveControlDeps();
  try {
    if (verb === "stop") await stopDaemon(d);
    else await restartDaemon(d);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

/** Remove the pidfile if it still names this process. */
export function removePidFile(home: string = homedir(), pid: number = process.pid): void {
  try {
    if (Number(readFileSync(pidFilePath(home), "utf8").trim()) === pid) rmSync(pidFilePath(home), { force: true });
  } catch { /* already gone */ }
}
