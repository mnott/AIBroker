/**
 * ipc/validate.ts — Runtime validation for IPC responses.
 *
 * IPC calls return Record<string, unknown>. These helpers validate
 * the shape at the system boundary so consumers get typed data
 * instead of unsafe casts.
 */

import type { AdapterHealth, AdapterConnectionStatus } from "../types/adapter.js";

// ── Generic Helpers ──

/** Assert a value is a non-null object. */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Pick a string field or return a default. */
function str(obj: Record<string, unknown>, key: string, fallback: string): string {
  const v = obj[key];
  return typeof v === "string" ? v : fallback;
}

/** Pick a number field or return a default. */
function num(obj: Record<string, unknown>, key: string, fallback: number): number {
  const v = obj[key];
  return typeof v === "number" ? v : fallback;
}

/** Pick a boolean field or return a default. */
function bool(obj: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = obj[key];
  return typeof v === "boolean" ? v : fallback;
}

// ── AdapterHealth ──

const VALID_STATUSES = new Set<string>(["ok", "degraded", "down"]);
const VALID_CONN = new Set<string>(["connected", "connecting", "disconnected", "error"]);

/**
 * Validate and coerce an IPC response into a typed AdapterHealth.
 * Returns a degraded health object if the response shape is wrong.
 */
export function validateAdapterHealth(raw: unknown): AdapterHealth {
  if (!isObject(raw)) {
    return {
      status: "down",
      connectionStatus: "disconnected",
      stats: { messagesReceived: 0, messagesSent: 0, errors: 0 },
      lastMessageAgo: null,
      detail: `Invalid health response: expected object, got ${typeof raw}`,
    };
  }

  const statusRaw = str(raw, "status", "down");
  const status = VALID_STATUSES.has(statusRaw) ? statusRaw as AdapterHealth["status"] : "down";

  const connRaw = str(raw, "connectionStatus", "disconnected");
  const connectionStatus = VALID_CONN.has(connRaw) ? connRaw as AdapterConnectionStatus : "disconnected";

  const statsRaw = raw.stats;
  let stats: AdapterHealth["stats"];
  if (isObject(statsRaw)) {
    stats = {
      messagesReceived: num(statsRaw, "messagesReceived", 0),
      messagesSent: num(statsRaw, "messagesSent", 0),
      errors: num(statsRaw, "errors", 0),
    };
  } else {
    stats = { messagesReceived: 0, messagesSent: 0, errors: 0 };
  }

  const lastMessageAgo = typeof raw.lastMessageAgo === "number" ? raw.lastMessageAgo : null;
  const detail = typeof raw.detail === "string" ? raw.detail : undefined;

  return { status, connectionStatus, stats, lastMessageAgo, detail };
}

// ── Session List ──

export interface ValidatedSession {
  index: number;
  name: string;
  kind: string;
  active: boolean;
}

/**
 * Validate a sessions IPC response.
 * Expects { sessions: Array<{ index, name, kind, active }> }.
 */
export function validateSessionList(raw: unknown): ValidatedSession[] {
  if (!isObject(raw)) return [];
  const sessions = raw.sessions;
  if (!Array.isArray(sessions)) return [];

  return sessions
    .filter(isObject)
    .map((s) => ({
      index: num(s, "index", 0),
      name: str(s, "name", "unknown"),
      kind: str(s, "kind", "unknown"),
      active: bool(s, "active", false),
    }));
}

// ── Status ──

export interface ValidatedHubStatus {
  version: string;
  adapters: string[];
  activeSessions: number;
  activeSession: string | null;
  adapterHealth: Record<string, AdapterHealth>;
}

/**
 * Validate a hub status IPC response.
 */
export function validateHubStatus(raw: unknown): ValidatedHubStatus {
  if (!isObject(raw)) {
    return { version: "unknown", adapters: [], activeSessions: 0, activeSession: null, adapterHealth: {} };
  }

  const adapters = Array.isArray(raw.adapters)
    ? (raw.adapters as unknown[]).filter((a): a is string => typeof a === "string")
    : [];

  const adapterHealth: Record<string, AdapterHealth> = {};
  if (isObject(raw.adapterHealth)) {
    for (const [name, h] of Object.entries(raw.adapterHealth)) {
      adapterHealth[name] = validateAdapterHealth(h);
    }
  }

  return {
    version: str(raw, "version", "unknown"),
    adapters,
    activeSessions: num(raw, "activeSessions", 0),
    activeSession: typeof raw.activeSession === "string" ? raw.activeSession : null,
    adapterHealth,
  };
}

// ── TTS Result ──

export interface ValidatedTtsResult {
  generated: boolean;
  voice: string;
  bytes: number;
}

/**
 * Validate a TTS IPC response.
 */
export function validateTtsResult(raw: unknown): ValidatedTtsResult {
  if (!isObject(raw)) {
    return { generated: false, voice: "unknown", bytes: 0 };
  }
  return {
    generated: bool(raw, "generated", false),
    voice: str(raw, "voice", "unknown"),
    bytes: num(raw, "bytes", 0),
  };
}

// ── Transcription Result ──

export interface ValidatedTranscription {
  text: string;
}

/**
 * Validate a transcription IPC response.
 */
export function validateTranscription(raw: unknown): ValidatedTranscription {
  if (!isObject(raw)) return { text: "" };
  return { text: str(raw, "text", "") };
}
