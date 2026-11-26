/**
 * apns/client.ts — Apple Push Notification service (APNs) client for AIBroker.
 *
 * Sends push notifications to PAILot devices when no MQTT clients are connected.
 * Device tokens are stored in ~/.aibroker/apns-tokens.json.
 *
 * Configuration (loaded from ~/.aibroker/env or process.env):
 *   APNS_KEY_PATH  — path to the .p8 auth key file
 *   APNS_KEY_ID    — 10-character key ID (e.g., C9Z39FRQ2N)
 *   APNS_TEAM_ID   — 10-character Apple Team ID (e.g., 7KU642K5ZL)
 *   APNS_PRODUCTION — set to "1" or "true" to use production APNs host
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { log } from "../core/log.js";
import { GuardedStore } from "../core/json-store.js";
import { deriveKPush, seal } from "../adapters/pailot/ble-crypto.js";

const require = createRequire(import.meta.url);

const APNS_BUNDLE_ID = "com.tekmidian.pailot";
const TOKENS_FILE = join(homedir(), ".aibroker", "apns-tokens.json");

// Lazy-loaded APNs client instance.
let apnsClient: any = null;
let apnsLoaded = false;

/**
 * Load and initialise the APNs client from environment variables.
 * Returns null if required config is missing or apns2 fails to load.
 */
function getApnsClient(): any | null {
  if (apnsLoaded) return apnsClient;
  apnsLoaded = true;

  const keyPath = process.env.APNS_KEY_PATH;
  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;

  if (!keyPath || !keyId || !teamId) {
    log("[APNs] missing config (APNS_KEY_PATH / APNS_KEY_ID / APNS_TEAM_ID) — push disabled");
    return null;
  }

  if (!existsSync(keyPath)) {
    log(`[APNs] key file not found: ${keyPath} — push disabled`);
    return null;
  }

  try {
    const { ApnsClient, Host } = require("apns2");

    const production = process.env.APNS_PRODUCTION === "1" || process.env.APNS_PRODUCTION === "true";
    const host = production ? Host.production : Host.development;

    const signingKey = readFileSync(keyPath, "utf-8");

    apnsClient = new ApnsClient({
      team: teamId,
      keyId,
      signingKey,
      host,
      defaultTopic: APNS_BUNDLE_ID,
    });

    log(`[APNs] client initialised (${production ? "production" : "sandbox"}, key=${keyId}, team=${teamId})`);
    return apnsClient;
  } catch (err) {
    log(`[APNs] failed to initialise client: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// --- Token storage ---

/**
 * Registered device tokens.
 *
 * Guarded because the read-then-write cycle here silently deletes devices: an
 * unreadable token file used to read as `[]`, the newly registering device was
 * appended to nothing, and the save persisted a one-element list. Every other
 * device stops receiving push, with no error at any point — and a notification
 * that never arrives is not something anyone notices for days.
 */
let _tokenStore: GuardedStore<string[]> | null = null;

function tokenStore(): GuardedStore<string[]> {
  if (_tokenStore === null) {
    _tokenStore = new GuardedStore<string[]>(TOKENS_FILE, () => [], "[APNs]");
  }
  return _tokenStore;
}

function loadTokens(): string[] {
  const raw = tokenStore().load();
  // Tolerate a hand-edited file that parsed but isn't the expected shape.
  return Array.isArray(raw) ? raw.filter((t): t is string => typeof t === "string") : [];
}

function saveTokens(tokens: string[]): void {
  const store = tokenStore();
  const cache = store.load();
  cache.length = 0;
  cache.push(...tokens);
  store.save();
}

/**
 * Register a device token. Silently ignores duplicates.
 */
export function registerToken(token: string): void {
  if (!token || typeof token !== "string") return;
  const tokens = loadTokens();
  if (!tokens.includes(token)) {
    tokens.push(token);
    saveTokens(tokens);
    log(`[APNs] registered token: ${token.slice(0, 16)}... (total: ${tokens.length})`);
  }
}

/**
 * Remove a device token (e.g., on InvalidToken APNs error).
 */
export function removeToken(token: string): void {
  const tokens = loadTokens().filter((t) => t !== token);
  saveTokens(tokens);
  log(`[APNs] removed token: ${token.slice(0, 16)}...`);
}

/**
 * Returns all registered device tokens.
 */
export function getTokens(): string[] {
  return loadTokens();
}

// --- Badge counter ---
// Tracks pending (unseen) push count. Incremented with each push,
// reset to 0 when an MQTT client connects (app is opened).
let pendingBadge = 0;

/** Reset badge counter — call when the app connects via MQTT. */
export function resetBadge(): void {
  pendingBadge = 0;
}

// --- Push sending ---

export interface PushPayload {
  title: string;
  body: string;
  badge?: number;
  data?: Record<string, unknown>;
  /** Full message to ride encrypted in the push (see buildPushPayload). */
  message?: PushMessage;
}

/** Plaintext sealed into the APNs "pl" key (wire contract v1). */
export interface PushMessage {
  v?: 1;
  msgId: string;
  seq?: number;
  sessionId: string;
  type: "text" | "voice" | "image";
  content?: string;
  sessionName: string;
  ts: number;
  audioPath?: string;
  audioSecs?: number;
  audioPort?: number;
}

export type PushMode = "full" | "ref" | "plain";

/** Safe budget for the whole JSON payload (APNs limit is 4096). */
export const PUSH_BUDGET_BYTES = 3800;

export interface BuiltPush {
  aps: Record<string, unknown>;
  custom: Record<string, unknown>;
  mode: PushMode;
  bytes: number;
  mutableContent: boolean;
}

let warnedNoToken = false;

/**
 * Pure: build the APNs payload and decide full / ref / plain.
 * full  = encrypted message with content in "pl"
 * ref   = encrypted metadata only ("ref":true), extension leaves the message to catch_up
 * plain = alert only (no token, sealing impossible, or nothing fits)
 * Content is never truncated and never logged.
 */
export function buildPushPayload(opts: {
  title: string;
  body: string;
  badge?: number;
  data?: Record<string, unknown>;
  message?: PushMessage;
  token?: string;
  nonce?: Buffer;
}): BuiltPush {
  const data = opts.data ?? {};
  const baseAps = { alert: { title: opts.title, body: opts.body }, badge: opts.badge ?? 1, sound: "default" };
  const size = (aps: Record<string, unknown>, custom: Record<string, unknown>) =>
    Buffer.byteLength(JSON.stringify({ aps, ...custom }), "utf8");
  const plain = (): BuiltPush => ({ aps: baseAps, custom: data, mode: "plain", bytes: size(baseAps, data), mutableContent: false });

  const m = opts.message;
  if (!m || !opts.token) return plain();
  const key = deriveKPush(opts.token);

  const attempt = (pl: Record<string, unknown>, mode: PushMode): BuiltPush | null => {
    const sealed = seal(key, Buffer.from(JSON.stringify(pl), "utf8"), opts.nonce).toString("base64");
    const custom = { ...data, pl: sealed, plv: 1, sessionId: m.sessionId };
    const aps = { ...baseAps, "mutable-content": 1, "thread-id": m.sessionId };
    const bytes = size(aps, custom);
    return bytes <= PUSH_BUDGET_BYTES ? { aps, custom, mode, bytes, mutableContent: true } : null;
  };

  const { content, ...meta } = m;
  const full = { v: 1, ...m };
  if (m.type !== "image" && content !== undefined) {
    const r = attempt(full, "full");
    if (r) return r;
  }
  return attempt({ v: 1, ...meta, ref: true }, "ref") ?? plain();
}

/**
 * Send a push notification to a single device token.
 * Returns true on success, false on failure.
 */
export async function sendPushToToken(token: string, payload: PushPayload, prebuilt?: BuiltPush): Promise<boolean> {
  const client = getApnsClient();
  if (!client) return false;

  try {
    const { Notification } = require("apns2");
    const built = prebuilt ?? buildPushPayload({
      title: payload.title, body: payload.body, badge: payload.badge, data: payload.data,
      message: payload.message, token: process.env.AIBROKER_BLE_TOKEN,
    });

    const notification = new Notification(token, {
      alert: { title: payload.title, body: payload.body },
      badge: payload.badge ?? 1,
      sound: "default",
      data: built.custom,
      ...(built.mutableContent && {
        mutableContent: true,
        threadId: (built.aps["thread-id"] as string | undefined),
      }),
    });

    await client.send(notification);
    log(`[APNs] push sent to ${token.slice(0, 16)}... — "${payload.title}: ${payload.body.slice(0, 40)}" mode=${built.mode} bytes=${built.bytes}`);
    return true;
  } catch (err: any) {
    const reason = err?.response?.reason ?? err?.message ?? String(err);
    log(`[APNs] push failed for ${token.slice(0, 16)}...: ${reason}`);

    // Clean up stale/invalid tokens automatically
    if (reason === "BadDeviceToken" || reason === "Unregistered" || reason === "DeviceTokenNotForTopic") {
      removeToken(token);
    }
    return false;
  }
}

/**
 * Send a push notification to all registered device tokens.
 * Returns the number of tokens that succeeded.
 */
export async function sendPush(
  title: string,
  body: string,
  data?: Record<string, unknown>,
  badge?: number,
  message?: PushMessage,
): Promise<number> {
  const tokens = getTokens();
  if (tokens.length === 0) {
    log("[APNs] no registered tokens — skipping push");
    return 0;
  }

  const client = getApnsClient();
  if (!client) return 0;

  // Increment pending badge counter
  pendingBadge++;
  const actualBadge = badge ?? pendingBadge;

  log(`[APNs] sending push to ${tokens.length} token(s): "${title}" (badge=${actualBadge})`);

  const secret = process.env.AIBROKER_BLE_TOKEN;
  if (message && !secret && !warnedNoToken) {
    warnedNoToken = true;
    log("[APNs] AIBROKER_BLE_TOKEN not set — pushes carry no encrypted message");
  }
  const built = buildPushPayload({ title, body, badge: actualBadge, data, message, token: secret });
  const results = await Promise.allSettled(
    tokens.map((token) => sendPushToToken(token, { title, body, badge: actualBadge, data }, built)),
  );

  const succeeded = results.filter((r) => r.status === "fulfilled" && r.value === true).length;
  log(`[APNs] push delivery: ${succeeded}/${tokens.length} succeeded`);
  return succeeded;
}

/**
 * Send a SILENT background push that clears the iOS home-screen badge.
 * resetBadge() alone only resets the in-memory counter — iOS keeps displaying
 * whatever number the last push set until a new push tells it otherwise. A
 * SilentNotification with badge: 0 is delivered as a background push (no alert,
 * no sound) and just repaints the icon. Call on app-connect (WS/MQTT) — the app
 * being online means the user is reading, so any pending count is stale.
 */
export async function sendBadgeClear(): Promise<void> {
  const tokens = getTokens();
  if (tokens.length === 0) return;
  const client = getApnsClient();
  if (!client) return;
  resetBadge();
  try {
    const { SilentNotification } = require("apns2");
    await Promise.allSettled(
      tokens.map((token) => client.send(new SilentNotification(token, { badge: 0 }))),
    );
    log(`[APNs] sent silent badge clear to ${tokens.length} token(s)`);
  } catch (err) {
    log(`[APNs] badge clear failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
