/**
 * core/json-store.ts — durable JSON state files.
 *
 * Every persisted store here follows the same shape: read it, modify it, write
 * it back. That shape has one catastrophic failure mode, and it is silent:
 *
 *   read fails -> caller substitutes an empty default -> write makes it permanent
 *
 * A file that is briefly unreadable, or corrupt from a half-finished write,
 * becomes an empty object. The next ordinary update — registering a device,
 * renaming a session — then persists that emptiness over real data and reports
 * success. Nothing errors, nothing logs, and the loss is only noticed later
 * when a push never arrives or every session has lost its name.
 *
 * The fix is to make "I could not read it" a THIRD outcome that callers cannot
 * accidentally treat as "it was empty":
 *
 *   missing     — legitimately absent, start fresh, writing is safe
 *   ok          — parsed, writing is safe
 *   unreadable  — exists but could not be parsed. NEVER overwrite: the bytes on
 *                 disk are the only copy of whatever is in there.
 *
 * Writes are atomic (temp + rename) so a crash mid-write cannot truncate a good
 * file into a corrupt one, and the previous contents are kept as `.bak` so even
 * a logic error upstream is recoverable.
 */

import { readFileSync, writeFileSync, existsSync, renameSync, copyFileSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { log } from "./log.js";

export type LoadResult<T> =
  | { status: "ok"; data: T }
  | { status: "missing" }
  | { status: "unreadable"; error: string };

/**
 * Read a JSON store, distinguishing absent from unreadable.
 *
 * Deliberately returns a result rather than `T | null`: a nullable return is
 * what lets `?? {}` quietly turn corruption into an empty store.
 */
export function loadJson<T>(path: string): LoadResult<T> {
  if (!existsSync(path)) return { status: "missing" };
  try {
    return { status: "ok", data: JSON.parse(readFileSync(path, "utf-8")) as T };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log(`json-store: ${path} exists but could not be read (${error}). ` +
        `Refusing to treat it as empty — writes to this store are now blocked to avoid overwriting it.`);
    return { status: "unreadable", error };
  }
}

/**
 * Write a JSON store atomically, keeping the previous contents as `.bak`.
 *
 * temp + rename means a reader never sees a partial file and a crash cannot
 * leave a truncated one, which is the usual way these files become corrupt in
 * the first place.
 */
export function saveJson(path: string, data: unknown, opts: { backup?: boolean } = {}): void {
  const { backup = true } = opts;
  mkdirSync(dirname(path), { recursive: true });

  // Skipped for high-churn stores where a copy on every write costs more than
  // the backup is worth; the atomic rename below is the part that matters.
  if (backup && existsSync(path)) {
    try { copyFileSync(path, `${path}.bak`); } catch { /* best effort */ }
  }

  const tmp = `${path}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    renameSync(tmp, path);
  } catch (err) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
}

/**
 * A store that refuses to save once its file has been found unreadable.
 *
 * Holding the flag matters as much as the initial check: these stores cache
 * their contents, so a single transient read failure at startup would
 * otherwise poison every later write for the lifetime of the process, long
 * after the file itself is readable again.
 */
export class GuardedStore<T> {
  private cache: T | null = null;
  private blocked = false;
  private blockedReason = "";

  constructor(
    private readonly path: string,
    private readonly empty: () => T,
    private readonly label: string,
  ) {}

  /** Contents, or an empty value when missing/unreadable. Never throws. */
  load(): T {
    if (this.cache !== null) return this.cache;
    const res = loadJson<T>(this.path);
    if (res.status === "ok") {
      this.cache = res.data;
    } else {
      if (res.status === "unreadable") {
        this.blocked = true;
        this.blockedReason = res.error;
      }
      this.cache = this.empty();
    }
    return this.cache;
  }

  /** True when the backing file could not be read and must not be overwritten. */
  isBlocked(): boolean { return this.blocked; }

  /**
   * Persist the cache. A no-op — loudly — when the file was unreadable, because
   * writing would replace data we were never able to see with the empty value
   * we substituted for it.
   */
  save(): boolean {
    if (this.blocked) {
      log(`${this.label}: NOT saving — ${this.path} was unreadable at load (${this.blockedReason}). ` +
          `The file is untouched; fix or remove it and restart to resume persistence.`);
      return false;
    }
    if (this.cache === null) return false;
    try {
      saveJson(this.path, this.cache);
      return true;
    } catch (err) {
      log(`${this.label}: failed to save ${this.path}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** Drop the in-memory copy (and any block) so the next load re-reads disk. */
  reset(): void {
    this.cache = null;
    this.blocked = false;
    this.blockedReason = "";
  }
}
