/**
 * daemon/launch-cli.ts — `aibroker launch <project>`, a session from a shell.
 *
 * Launching already existed over IPC, reachable from a session that has the
 * tool. That is the wrong shape for the one case that matters most: bringing
 * work back after the machine restarted. At that moment there is no session to
 * hold the tool — that is the whole problem — so the capability has to be
 * reachable from a script and from a bare prompt, which means a CLI verb.
 *
 * A directory opens a plain Claude Code session there through the active
 * transport (a tmux window on Linux, an iTerm tab on macOS); a bare PAI project
 * name keeps going through `pai_launch`. The transport call runs in this
 * process, not the daemon: the caller's $TMUX says which tmux session is "here",
 * and it works while the daemon is down, which is when restoring matters.
 *
 * It prints the session id because the caller's next move is almost
 * always to manage or arm the thing it just created, and that needs the id.
 */

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { WatcherClient } from "../ipc/client.js";
import { resolveBin } from "../core/bins.js";
import { selectTransport } from "../transport/index.js";
import type { LaunchResult, SessionTransport } from "../transport/index.js";
import { DAEMON_SOCKET_PATH } from "./index.js";

export interface LiveRow {
  sessionId: string;
  paiName?: string | null;
  name?: string;
  kind?: string;
  cwd?: string | null;
  transport?: string;
}

export interface LaunchDeps {
  transport: () => SessionTransport;
  /** Live rows from the daemon; an unreachable daemon is an empty list, not an error. */
  sessions: () => Promise<LiveRow[]>;
  paiLaunch: (name: string) => Promise<{ itermSessionId?: string; name?: string }>;
  isDir: (path: string) => boolean;
  paiPresent: () => boolean;
  cwd: string;
  home: string;
  out: (line: string) => void;
}

export type LaunchTarget =
  | { kind: "dir"; dir: string; name: string }
  | { kind: "pai"; name: string };

/** `[--name N] <target>` in any order. */
export function parseLaunchArgs(args: string[]): { target?: string; name?: string } {
  let name: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--name") name = args[++i];
    else if (args[i].startsWith("--name=")) name = args[i].slice(7);
    else rest.push(args[i]);
  }
  return { target: rest[0], name };
}

/**
 * Directory or PAI project? A path-like argument (`/x`, `./x`, `~/x`, `a/b`)
 * is always a directory. A bare word stays a PAI project wherever PAI exists —
 * on macOS `launch whazaa` must keep meaning the project even when a `whazaa`
 * directory sits in the working directory — and is a directory otherwise.
 */
export function resolveLaunchTarget(
  target: string,
  nameOverride: string | undefined,
  deps: Pick<LaunchDeps, "isDir" | "paiPresent" | "cwd" | "home">,
): LaunchTarget {
  const pathLike = /[\\/]/.test(target) || target.startsWith(".") || target.startsWith("~");
  const bare = !pathLike;
  if (bare && deps.paiPresent()) return { kind: "pai", name: target };
  const expanded = target === "~" ? deps.home : target.startsWith("~/") ? deps.home + target.slice(1) : target;
  const dir = resolve(deps.cwd, expanded);
  if (!deps.isDir(dir)) {
    throw new Error(
      bare
        ? `"${target}" is not a directory here and PAI is not installed, so it is not a project name either`
        : `"${target}" is not a directory`,
    );
  }
  return { kind: "dir", dir, name: nameOverride || basename(dir) };
}

/**
 * Attach before spawning. Launching is not the point — HAVING a session for
 * this project is, and a second pane in the same repository is worse than no
 * pane at all: two agents claiming the same issues, committing over each
 * other, neither aware of the other. The recovery case cannot tell in advance
 * whether the machine restarted or the caller simply asked twice, so the only
 * safe shape is idempotent.
 *
 * Match on paiName, which is the project identity the daemon assigns, rather
 * than on the terminal's title, which carries spinner glyphs and process
 * names and would match a bare shell sitting in the same directory. A launched
 * directory session has no paiName yet, so it is matched by its name or its
 * directory — but only when it is a live Claude, never a shell.
 */
export function findRunning(rows: LiveRow[], name: string, dir?: string): LiveRow | undefined {
  const lower = name.toLowerCase();
  return rows.find(
    (r) =>
      (r.paiName && r.paiName.toLowerCase() === lower) ||
      (r.kind === "claude" &&
        ((r.name ?? "").toLowerCase() === lower || (dir !== undefined && r.cwd === dir))),
  );
}

const liveDeps = (): LaunchDeps => ({
  transport: selectTransport,
  sessions: async () => {
    try {
      const res = (await new WatcherClient(DAEMON_SOCKET_PATH).call_raw("sessions", {})) as
        | LiveRow[]
        | { sessions?: LiveRow[] };
      return Array.isArray(res) ? res : (res?.sessions ?? []);
    } catch {
      return [];
    }
  },
  /*
   * call_raw returns the handler's RESULT, not the {ok, result} envelope the
   * handler writes — the client unwraps it and throws on failure. Checking for
   * `ok` here therefore read undefined on every success and reported a launch
   * that had in fact happened as a failure, which is the worst way to be wrong:
   * the caller sees an error and tries again, and now there are two sessions.
   * Success is a session id coming back; anything else is a failure to say out
   * loud.
   */
  paiLaunch: async (name) =>
    (await new WatcherClient(DAEMON_SOCKET_PATH).call_raw("pai_launch", { name })) as {
      itermSessionId?: string;
      name?: string;
    },
  isDir: (p) => existsSync(p) && statSync(p).isDirectory(),
  paiPresent: () => resolveBin("pai") !== "pai",
  cwd: process.cwd(),
  home: homedir(),
  out: (l) => console.log(l),
});

/** Returns the process exit code. */
export async function launch(args: string[], deps: LaunchDeps): Promise<number> {
  const { target, name: nameArg } = parseLaunchArgs(args);
  if (!target) {
    console.error("Usage: aibroker launch <dir|pai-project> [--name N]");
    return 1;
  }

  let resolved: LaunchTarget;
  try {
    resolved = resolveLaunchTarget(target, nameArg, deps);
  } catch (err) {
    console.error(`Could not launch: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const rows = await deps.sessions();
  const already = findRunning(rows, resolved.name, resolved.kind === "dir" ? resolved.dir : undefined);
  if (already) {
    deps.out(`${already.paiName ?? already.name ?? resolved.name} is already running — attached, nothing launched.`);
    deps.out(`  ${already.transport ?? "iterm"} ${already.sessionId}`);
    return 0;
  }

  if (resolved.kind === "pai") {
    let res: { itermSessionId?: string; name?: string };
    try {
      res = await deps.paiLaunch(resolved.name);
    } catch (err) {
      console.error(`Could not launch ${resolved.name}: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    if (!res?.itermSessionId) {
      console.error(`Could not launch ${resolved.name}: the daemon returned no session`);
      return 1;
    }
    deps.out(`Launched ${res.name ?? resolved.name}`);
    deps.out(`  iterm ${res.itermSessionId}`);
    return 0;
  }

  let res: LaunchResult | null = null;
  try {
    res = deps.transport().launch({ dir: resolved.dir, name: resolved.name });
  } catch (err) {
    console.error(`Could not launch ${resolved.name}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (!res) {
    console.error(`Could not launch ${resolved.name}: the terminal host refused (is tmux installed?)`);
    return 1;
  }
  deps.out(`Launched ${resolved.name} in ${resolved.dir}`);
  deps.out(`  ${res.transport} ${res.id}  (${res.where})`);
  if (res.attach) deps.out(`  attach: ${res.attach}`);
  return 0;
}

export async function runLaunch(args: string[]): Promise<void> {
  const code = await launch(args, liveDeps());
  if (code !== 0) process.exit(code);
}
