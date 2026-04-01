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

function loadTokens(): string[] {
  try {
    if (!existsSync(TOKENS_FILE)) return [];
    const raw = readFileSync(TOKENS_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

function saveTokens(tokens: string[]): void {
  try {
    const dir = join(homedir(), ".aibroker");
    mkdirSync(dir, { recursive: true });
    writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2), "utf-8");
  } catch (err) {
    log(`[APNs] failed to save tokens: ${err instanceof Error ? err.message : String(err)}`);
  }
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

// --- Push sending ---

export interface PushPayload {
  title: string;
  body: string;
  badge?: number;
  data?: Record<string, unknown>;
}

/**
 * Send a push notification to a single device token.
 * Returns true on success, false on failure.
 */
export async function sendPushToToken(token: string, payload: PushPayload): Promise<boolean> {
  const client = getApnsClient();
  if (!client) return false;

  try {
    const { Notification } = require("apns2");

    const notification = new Notification(token, {
      alert: {
        title: payload.title,
        body: payload.body,
      },
      badge: payload.badge ?? 1,
      sound: "default",
      data: payload.data ?? {},
    });

    await client.send(notification);
    log(`[APNs] push sent to ${token.slice(0, 16)}... — "${payload.title}: ${payload.body.slice(0, 40)}"`);
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
  badge = 1,
): Promise<number> {
  const tokens = getTokens();
  if (tokens.length === 0) {
    log("[APNs] no registered tokens — skipping push");
    return 0;
  }

  const client = getApnsClient();
  if (!client) return 0;

  log(`[APNs] sending push to ${tokens.length} token(s): "${title}"`);

  const results = await Promise.allSettled(
    tokens.map((token) => sendPushToToken(token, { title, body, badge, data })),
  );

  const succeeded = results.filter((r) => r.status === "fulfilled" && r.value === true).length;
  log(`[APNs] push delivery: ${succeeded}/${tokens.length} succeeded`);
  return succeeded;
}
