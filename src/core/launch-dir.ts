/**
 * core/launch-dir.ts — the one place a launch directory is turned into a
 * shell-safe `cd` target.
 *
 * PAILot sends the home directory as the literal string "~". Single-quoting it
 * (`'~'`) stops the shell from expanding it, so every launch of the home
 * directory failed with `cd: no such file or directory: ~` (live 2026-11-24).
 * Expansion therefore has to happen BEFORE quoting, in one shared helper both
 * launch builders use — a fix in one builder leaves the other broken.
 *
 * A directory that does not exist is refused here rather than typed into a
 * fresh tab: a failed `cd` leaves the tab on a bare shell with Claude never
 * started, which reads as a session that exists but does nothing.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";

/** Expand a leading `~` / `~/` to the user's home directory. */
export function expandTilde(dir: string): string {
  if (dir === "~") return homedir();
  if (dir.startsWith("~/")) return homedir() + dir.slice(1);
  return dir;
}

/**
 * Resolve a launch directory: expand a leading tilde, then refuse a directory
 * that does not exist with a clear message.
 */
export function resolveLaunchDir(dir: string): string {
  const expanded = expandTilde(dir);
  if (!existsSync(expanded)) {
    throw new Error(`Launch directory "${dir}" does not exist${expanded !== dir ? ` (expanded from "~" to "${expanded}")` : ""}.`);
  }
  return expanded;
}
