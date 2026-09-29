/**
 * Lazy binary resolution. Resolving at import time froze the answer for the
 * life of the process, so a tool installed after the daemon started was never
 * found. Callers resolve at the point of use instead.
 *
 * Absolute Homebrew paths come first because the launchd PATH excludes
 * /opt/homebrew/bin; a search of the current PATH covers everything else.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export function resolveBin(name: string): string {
  const upper = name.toUpperCase();
  const override = process.env[`AIBROKER_${upper}_BIN`];
  if (override && existsSync(override)) return override;
  for (const dir of [join(homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", ...(process.env.PATH ?? "").split(delimiter)]) {
    if (dir && existsSync(join(dir, name))) return join(dir, name);
  }
  return name;
}

export const resolveWhisperBin = (): string => resolveBin("whisper");
export const resolveFfmpegBin = (): string => resolveBin("ffmpeg");
export const resolveSoxBin = (): string => resolveBin("sox");

/**
 * argv prefix that plays an audio file on this host, or null when there is no
 * local player. macOS ships afplay; elsewhere use the first of paplay / aplay /
 * ffplay that resolves. `resolveBin` echoes the bare name when nothing matches,
 * so "found" means it came back as an absolute path.
 */
export function localPlayerCommand(platform: NodeJS.Platform = process.platform): string[] | null {
  if (platform === "darwin") return ["afplay"];
  const candidates: string[][] = [["paplay"], ["aplay", "-q"], ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet"]];
  for (const [name, ...args] of candidates) {
    const bin = resolveBin(name);
    if (bin !== name) return [bin, ...args];
  }
  return null;
}

/**
 * A process's working directory from the operating system: /proc on Linux,
 * lsof on macOS (which has no /proc). null when it cannot be read.
 */
export function processCwd(pid: string, platform: NodeJS.Platform = process.platform): string | null {
  try {
    if (platform === "linux") return readlinkSync(`/proc/${pid}/cwd`);
    const out = execFileSync("/usr/sbin/lsof", ["-p", pid, "-a", "-d", "cwd", "-Fn"], { encoding: "utf8", timeout: 4_000 });
    return out.split("\n").find((l) => l.startsWith("n"))?.slice(1) ?? null;
  } catch {
    return null;
  }
}
