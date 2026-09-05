/**
 * a2a/exposure.ts — which sessions the operator has chosen to publish as
 * A2A skills.
 *
 * Mirrors inbound.ts's rule: "a route names its session; the payload never
 * does." The AgentCard is a directory a stranger reads before ever
 * proving anything — the first thing a stranger does with a directory is
 * enumerate it — so the card must never list more than the operator
 * explicitly chose. Every persistent session name would be the wrong
 * default: it turns a card fetch into a roster of every project this
 * machine works on. Default is empty; nothing is exposed until the
 * operator runs `aibroker a2a expose <session>`.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { loadJson, saveJson } from "../core/json-store.js";
import { log } from "../core/log.js";
import { audit } from "../daemon/audit.js";

export interface ExposedSession {
  name: string;
  description?: string;
}

interface Store { sessions: ExposedSession[] }

function defaultFile(): string {
  return join(homedir(), ".aibroker", "a2a-exposed.json");
}

function read(file: string): Store {
  const r = loadJson<Store>(file);
  if (r.status === "ok" && Array.isArray(r.data?.sessions)) return r.data;
  if (r.status === "unreadable") {
    log(`a2a-exposure: ${file} is unreadable — treating as nothing exposed until it is fixed`);
  }
  return { sessions: [] };
}

export function listExposed(file: string = defaultFile()): ExposedSession[] {
  return read(file).sessions;
}

/** Case-insensitive, matching how session names are matched elsewhere. */
export function findExposed(name: string, file: string = defaultFile()): ExposedSession | undefined {
  const want = name.trim().toLowerCase();
  return read(file).sessions.find((s) => s.name.toLowerCase() === want);
}

export function isExposed(name: string, file: string = defaultFile()): boolean {
  return findExposed(name, file) !== undefined;
}

export function expose(name: string, description: string | undefined, file: string = defaultFile()): ExposedSession {
  const clean = name.trim();
  if (!clean) throw new Error("session name must not be empty");
  const s = read(file);
  const existing = s.sessions.find((e) => e.name.toLowerCase() === clean.toLowerCase());
  const entry: ExposedSession = existing ?? { name: clean };
  entry.name = clean;
  if (description !== undefined) entry.description = description;
  if (!existing) s.sessions.push(entry);
  saveJson(file, s);
  audit({ action: "a2a-expose", actor: "aibroker", target: `session:${clean}`, outcome: existing ? "updated" : "exposed" });
  log(`a2a: ${clean} is ${existing ? "still" : "now"} exposed as an A2A skill${entry.description ? ` ("${entry.description}")` : ""}`);
  return entry;
}

export function unexpose(name: string, file: string = defaultFile()): boolean {
  const s = read(file);
  const before = s.sessions.length;
  s.sessions = s.sessions.filter((e) => e.name.toLowerCase() !== name.trim().toLowerCase());
  if (s.sessions.length === before) return false;
  saveJson(file, s);
  audit({ action: "a2a-expose", actor: "aibroker", target: `session:${name}`, outcome: "unexposed" });
  log(`a2a: ${name} is no longer exposed as an A2A skill`);
  return true;
}
