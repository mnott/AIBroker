/**
 * Log files are created 0600 and tightened to 0600 on every open, so a file
 * that pre-exists with looser bits (or was made by launchd) does not stay
 * world-readable.
 */

import { appendFileSync, chmodSync, existsSync, writeFileSync } from "node:fs";

/** Create the file if missing and force mode 0600. Best effort on chmod. */
export function tightenLog(path: string): void {
  if (!existsSync(path)) writeFileSync(path, "", { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* not ours to change */ }
}

export function appendPrivate(path: string, data: string): void {
  appendFileSync(path, data, { encoding: "utf-8", mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* not ours to change */ }
}

export function writePrivate(path: string, data: string): void {
  writeFileSync(path, data, { encoding: "utf-8", mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* not ours to change */ }
}
