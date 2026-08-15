/**
 * daemon/machine.ts — what this machine is, so work can be sent to the right one.
 *
 * THE MODEL. A fleet of machines running agents is not a distributed-systems
 * problem, it is a team. Each machine is a developer with their own computer,
 * their own checkout and their own branch; git is already the protocol for
 * merging their work, and it was designed for exactly this — people who cannot
 * see each other's screens, working in parallel, reconciling later. Nothing here
 * tries to improve on that.
 *
 * What a team does need, and what a lone machine never did, is to know who can
 * take which job. Sending a build to a machine without a compiler, or screen
 * verification to one with no display, fails slowly and confusingly rather than
 * immediately. So each hub says what it is, and the answer travels with every
 * ping.
 *
 * DELIBERATELY DESCRIPTIVE, NOT PRESCRIPTIVE. This reports what is true of the
 * machine; it does not enforce anything. A scheduler may ignore it. The failure
 * of a capability list is always that it drifts from reality, so everything here
 * is measured at the moment of asking rather than written into a config file
 * somebody has to remember to update.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { hostname, totalmem, cpus, release } from "node:os";

export interface MachineFacts {
  /** What a person calls this machine. */
  name: string;
  host: string;
  os: string;
  arch: string;
  cpus: number;
  memoryGb: number;
  /** Can it drive a screen — is there a window server with a display attached. */
  canDriveScreen: boolean;
  /** Toolchains that are actually present, not ones somebody hoped for. */
  has: string[];
  /** Where this hub keeps checkouts, if it has been told. */
  workRoot?: string;
}

function quiet(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout: 4_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/**
 * Is there a usable screen here?
 *
 * A machine can be running, reachable and perfectly healthy while having no
 * display at all — a headless server, or a VM whose window server never came
 * up. Sending screen work there produces a long confusing failure rather than a
 * short clear one, so it is worth one cheap question up front.
 */
function screenAvailable(): boolean {
  if (process.platform === "darwin") {
    const out = quiet("/usr/sbin/system_profiler", ["SPDisplaysDataType", "-detailLevel", "mini"]);
    return !!out && /Resolution|Display Type|UI Looks like/i.test(out);
  }
  // On Linux the question is whether a display server is reachable, not whether
  // hardware exists — a machine with a GPU and no session running is as unable
  // to be driven as one with no GPU at all. Both protocols, because a Wayland
  // desktop with no X compatibility has no DISPLAY and is still perfectly
  // drivable by something that speaks Wayland.
  return !!(process.env.WAYLAND_DISPLAY || process.env.DISPLAY);
}

/**
 * Which toolchains are here, asked the same way on every platform.
 *
 * `env <tool> --version` rather than a hardcoded path, because a path is a
 * guess about somebody's package manager: Homebrew, a distribution package and
 * a Nix store put the same binary in three different places, and a probe that
 * only knows one of them reports a machine as lacking a compiler it has.
 *
 * The macOS-only entries are asked only on macOS, so a Linux peer does not
 * spend four process launches learning it has no Xcode.
 */
function toolchains(): string[] {
  const has = (tool: string) => quiet("/usr/bin/env", [tool, "--version"]) !== null;
  const found: string[] = [];

  for (const t of ["node", "python3", "git", "docker", "tmux", "cargo", "go", "java"]) {
    if (has(t)) found.push(t);
  }

  if (process.platform === "darwin") {
    if (existsSync("/Applications/Xcode.app") || quiet("/usr/bin/xcodebuild", ["-version"]) !== null) found.push("xcode");
    if (has("swift")) found.push("swift");
  }

  // A session transport is a capability like any other: without one, a machine
  // can be paired and reachable and still have nowhere to put an agent. On
  // Linux tmux IS the transport, so its absence is the thing worth knowing.
  if (process.platform === "darwin") found.push("iterm-or-tmux");

  return found;
}

let cached: { at: number; facts: MachineFacts } | null = null;

/**
 * Facts about this machine, re-measured occasionally.
 *
 * Cached for a few minutes because probing toolchains costs several process
 * launches and the answer rarely changes — but not cached forever, because
 * "Xcode finished installing" is exactly the sort of change that should not
 * require a daemon restart to become visible.
 */
export function machineFacts(): MachineFacts {
  const FRESH_MS = 5 * 60_000;
  if (cached && Date.now() - cached.at < FRESH_MS) return cached.facts;

  const facts: MachineFacts = {
    name: process.env.AIBROKER_MACHINE_NAME ?? hostname().replace(/\.local$/, ""),
    host: hostname(),
    os: `${process.platform} ${release()}`,
    arch: process.arch,
    cpus: cpus().length,
    memoryGb: Math.round(totalmem() / 1024 / 1024 / 1024),
    canDriveScreen: screenAvailable(),
    has: toolchains(),
    workRoot: process.env.AIBROKER_WORK_ROOT,
  };
  cached = { at: Date.now(), facts };
  return facts;
}

/**
 * The state of a checkout, so a lead can ask "where are you" without asking.
 *
 * Reported rather than controlled. The whole point of giving each machine its
 * own branch is that it works without permission; what the fleet needs back is
 * enough to decide whether the work is ready to look at.
 */
export function branchState(repo: string): {
  repo: string;
  branch?: string;
  head?: string;
  dirty?: number;
  ahead?: number;
  behind?: number;
  error?: string;
} {
  const git = (args: string[]) => {
    try {
      return execFileSync("/usr/bin/env", ["git", "-C", repo, ...args], {
        encoding: "utf8",
        timeout: 6_000,
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return null;
    }
  };

  if (!existsSync(repo)) return { repo, error: "no such directory here" };
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === null) return { repo, error: "not a git checkout" };

  const head = git(["rev-parse", "--short", "HEAD"]) ?? undefined;
  const status = git(["status", "--porcelain"]);
  const dirty = status ? status.split("\n").filter(Boolean).length : 0;

  // Ahead/behind only mean something with an upstream; absent is not an error,
  // it is a branch nobody has pushed yet, which is the normal state of work in
  // progress and should not be reported as a fault.
  let ahead: number | undefined;
  let behind: number | undefined;
  const counts = git(["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]);
  if (counts) {
    const [b, a] = counts.split(/\s+/).map((n) => Number(n));
    behind = b;
    ahead = a;
  }

  return { repo, branch, head, dirty, ahead, behind };
}
