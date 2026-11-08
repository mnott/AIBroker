/**
 * daemon/owner-rename.ts — `aibroker owner rename "OLD" "NEW"`.
 *
 * A session or project is renamed in the terminal; AIBroker state that refers
 * to it BY NAME does not follow. The visible failure is an inbound route whose
 * `owner` is the old name: events keep arriving and nothing receives them.
 *
 * Only exact matches on name fields are rewritten — never substrings, never
 * keys, never free text. Output names files, fields, counts and ids; it never
 * prints file contents (inbound.json holds webhook secrets).
 *
 * Who owns the state while this runs:
 *   inbound.json, session-restore.json, session-names-projects.json
 *       read from disk on every use by the daemon — rewriting the file is enough.
 *   managers.json
 *       the daemon keeps it in memory and saves that copy back on every change,
 *       so a file edit would be overwritten at the next tick. With the daemon
 *       up, the CLI asks it (`owner-rename` IPC) to rename its in-memory state
 *       and save; with it down, the file is rewritten directly.
 *
 * session-history.json and pai-projects-last-good.json are deliberately left
 * alone: one is a record of what happened, the other a known-good snapshot.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { loadJson, saveJson } from "../core/json-store.js";

export interface RenameChange {
  file: string;
  field: string;
  count: number;
  ids: string[];
}

export interface RenameReport {
  changes: RenameChange[];
  errors: string[];
}

export function stateDir(): string {
  return process.env.AIBROKER_STATE_DIR || join(homedir(), ".aibroker");
}


function rewrite<T>(
  dir: string,
  file: string,
  field: string,
  dryRun: boolean,
  report: RenameReport,
  scan: (data: T) => string[],
): void {
  const path = join(dir, file);
  const r = loadJson<T>(path);
  if (r.status === "missing") return;
  if (r.status === "unreadable") {
    report.errors.push(`${file}: unreadable, left untouched`);
    return;
  }
  const ids = scan(r.data);
  if (ids.length === 0) return;
  report.changes.push({ file, field, count: ids.length, ids });
  if (!dryRun) saveJson(path, r.data);
}

/** Rename in the files the daemon reads fresh on every use. */
export function renameInFiles(
  dir: string, oldName: string, newName: string, dryRun: boolean,
  opts: { managers?: boolean } = {},
): RenameReport {
  const report: RenameReport = { changes: [], errors: [] };

  rewrite<{ routes?: { name: string; owner: string }[] }>(dir, "inbound.json", "routes[].owner", dryRun, report, (d) => {
    const hit = (Array.isArray(d?.routes) ? d.routes : []).filter((x) => x && x.owner === oldName);
    if (!dryRun) for (const x of hit) x.owner = newName;
    return hit.map((x) => x.name);
  });

  if (opts.managers) {
    rewrite<Record<string, { name?: string }>>(dir, "managers.json", "<sessionId>.name", dryRun, report, (d) => {
      const hit = Object.entries(d ?? {}).filter(([, m]) => m && m.name === oldName);
      if (!dryRun) for (const [, m] of hit) m.name = newName;
      return hit.map(([id]) => id);
    });
  }

  rewrite<{ mailboxes?: { name: string; owner: string }[] }>(dir, "mail-ingress.json", "mailboxes[].owner", dryRun, report, (d) => {
    const hit = (Array.isArray(d?.mailboxes) ? d.mailboxes : []).filter((x) => x && x.owner === oldName);
    if (!dryRun) for (const x of hit) x.owner = newName;
    return hit.map((x) => x.name);
  });

  rewrite<{ entries?: { name?: string }[] } | { name?: string }[]>(dir, "session-restore.json", "entries[].name", dryRun, report, (d) => {
    const list = Array.isArray(d) ? d : Array.isArray(d?.entries) ? d.entries : [];
    const hit = list.map((e, i) => ({ e, i })).filter(({ e }) => e && e.name === oldName);
    if (!dryRun) for (const { e } of hit) e.name = newName;
    return hit.map(({ i }) => `#${i}`);
  });

  rewrite<Record<string, string>>(dir, "session-names-projects.json", "<sessionId> value", dryRun, report, (d) => {
    const hit = Object.keys(d ?? {}).filter((k) => d[k] === oldName);
    if (!dryRun) for (const k of hit) d[k] = newName;
    return hit;
  });

  return report;
}

/** Full rename against a state dir, managers.json included (daemon not running). */
export function renameOwner(dir: string, oldName: string, newName: string, dryRun: boolean): RenameReport {
  return renameInFiles(dir, oldName, newName, dryRun, { managers: true });
}

export function formatReport(rep: RenameReport, oldName: string, newName: string, dryRun: boolean): string[] {
  const out: string[] = [];
  if (rep.changes.length === 0 && rep.errors.length === 0) {
    out.push(`Nothing to rename: no reference to "${oldName}" found (already renamed?).`);
    return out;
  }
  out.push(dryRun ? `Plan (dry run, nothing written): "${oldName}" -> "${newName}"` : `Renamed "${oldName}" -> "${newName}"`);
  for (const c of rep.changes) {
    out.push(`  ${c.file}  ${c.field}  x${c.count}  [${c.ids.join(", ")}]`);
  }
  for (const e of rep.errors) out.push(`  ERROR ${e}`);
  return out;
}

