/**
 * daemon/todoist-oauth.ts — the OAuth landing the redirect URL actually needs.
 *
 * Todoist does not deliver webhooks to the account that created the app. The
 * app has to be authorised like any third party would authorise it, and the
 * console's "install for myself" button does not do that — only a completed
 * OAuth round trip does. Todoist's own guidance is to run the flow by hand and
 * lift the `code` out of the address bar with developer tools, then exchange it
 * from a separate HTTP client because the exchange has to be a POST.
 *
 * That instruction is a description of a missing endpoint. The redirect URL is
 * ours; if it serves nothing, the browser lands on a 404 and the human has to
 * play proxy for a machine-to-machine step. So we serve it: this module takes
 * the `code` off the redirect, does the token exchange itself, stores the token
 * and reports what happened — on the page and in the audit trail.
 *
 * The state parameter is not decoration. `aibroker todoist auth` mints one and
 * records it; a callback that cannot present it is refused, because otherwise
 * anyone who can reach the redirect can drive a code of their choosing into
 * this exchange.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../core/log.js";
import { audit } from "./audit.js";

const STATE_DIR = join(homedir(), ".aibroker");
const TOKEN_FILE = join(STATE_DIR, "todoist-oauth.json");
const PENDING_FILE = join(STATE_DIR, "todoist-oauth-pending.json");

/** Anything Todoist hands back on a successful exchange, plus when we got it. */
export interface StoredToken {
  access_token: string;
  token_type: string;
  scope?: string;
  obtained_at: string;
  /**
   * Rotated on every refresh — the previous one stops working.
   *
   * Absent for legacy apps, which get a ten-year access token instead.
   */
  refresh_token?: string;
  /** Absolute expiry, ISO. Todoist issues one-hour access tokens. */
  expires_at?: string;
}

interface Pending {
  state: string;
  created_at: string;
}

/** A pending authorisation is only good for one attempt, and not for long. */
const PENDING_TTL_MS = 15 * 60 * 1000;

function writePrivate(file: string, data: unknown): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
  // The token is a bearer credential for the whole account. Group and world
  // have no business reading it, and the default umask is not a guarantee.
  chmodSync(file, 0o600);
}

function readJson<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as T;
  } catch {
    // A corrupt file is not a reason to erase it — see core/json-store.
    return null;
  }
}

/** Mint and record the state for one authorisation attempt. */
export function beginAuth(): string {
  const state = randomBytes(16).toString("hex");
  writePrivate(PENDING_FILE, { state, created_at: new Date().toISOString() } satisfies Pending);
  return state;
}

/**
 * Check a callback's state against the recorded one and consume it.
 *
 * Returns a reason when it does not hold up, so the caller can say precisely
 * what was wrong rather than "invalid request".
 */
export function consumeState(got: string | null): { ok: true } | { ok: false; reason: string } {
  const pending = readJson<Pending>(PENDING_FILE);
  if (!pending) return { ok: false, reason: "no authorisation is in progress — run `aibroker todoist auth` first" };
  if (Date.now() - Date.parse(pending.created_at) > PENDING_TTL_MS) {
    unlinkSync(PENDING_FILE);
    return { ok: false, reason: "the authorisation attempt expired — run `aibroker todoist auth` again" };
  }
  if (!got || got !== pending.state) return { ok: false, reason: "state did not match the pending authorisation" };
  unlinkSync(PENDING_FILE);
  return { ok: true };
}

export function loadToken(): StoredToken | null {
  return readJson<StoredToken>(TOKEN_FILE);
}

export function saveToken(t: StoredToken): void {
  writePrivate(TOKEN_FILE, t);
}

/** Build the URL a browser has to visit to authorise the app. */
export function authorizeUrl(clientId: string, scope: string, state: string): string {
  const q = new URLSearchParams({ client_id: clientId, scope, state });
  return `https://todoist.com/oauth/authorize?${q.toString()}`;
}

/**
 * Trade the authorisation code for a token.
 *
 * Kept separate from the request handler so the exchange can be tested and so
 * the secret is used in exactly one place.
 */
export async function exchangeCode(
  clientId: string,
  clientSecret: string,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<StoredToken> {
  const res = await fetchImpl("https://todoist.com/oauth/access_token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code }).toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`token exchange returned ${res.status}: ${text.slice(0, 200)}`);

  return parseTokenResponse(text);
}

/**
 * Turn a token response into something storable.
 *
 * `expires_in` and `refresh_token` are the fields that matter and were dropped
 * by the first version of this module. Todoist issues ONE-HOUR access tokens,
 * so a token stored without them works beautifully and then stops, roughly an
 * hour later, with a 401 that reads exactly like a revoked grant. That cost two
 * rounds of "the authorisation lapsed again" before anyone read the response
 * body closely enough to notice what had been thrown away.
 */
function parseTokenResponse(text: string): StoredToken {
  let body: {
    access_token?: string; token_type?: string; scope?: string;
    expires_in?: number; refresh_token?: string; error?: string;
  };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new Error(`token exchange returned unparseable body: ${text.slice(0, 200)}`);
  }
  if (body.error) throw new Error(`token exchange refused: ${body.error}`);
  if (!body.access_token) throw new Error("token exchange returned no access_token");

  return {
    access_token: body.access_token,
    token_type: body.token_type ?? "Bearer",
    scope: body.scope,
    obtained_at: new Date().toISOString(),
    refresh_token: body.refresh_token,
    expires_at: body.expires_in
      ? new Date(Date.now() + body.expires_in * 1000).toISOString()
      : undefined,
  };
}

/** Refresh a little early: a token that expires mid-request is a failed request. */
const REFRESH_MARGIN_MS = 120_000;

export function isExpired(t: StoredToken, now: number = Date.now()): boolean {
  if (!t.expires_at) return false; // legacy long-lived token
  return Date.parse(t.expires_at) - REFRESH_MARGIN_MS <= now;
}

/**
 * Trade the refresh token for a new access token.
 *
 * The refresh token ROTATES: the one we present stops working and the response
 * carries its replacement. Failing to store the new one turns the next refresh
 * into `invalid_grant`, which is indistinguishable from a revoked grant and
 * sends whoever debugs it to the wrong place.
 */
export async function refreshAccessToken(
  clientId: string,
  clientSecret: string,
  token: StoredToken,
  fetchImpl: typeof fetch = fetch,
): Promise<StoredToken> {
  if (!token.refresh_token) throw new Error("no refresh token on file — run `aibroker todoist auth`");

  const res = await fetchImpl("https://api.todoist.com/oauth/access_token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: token.refresh_token,
    }).toString(),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`token refresh returned ${res.status}: ${text.slice(0, 200)}`);

  const next = parseTokenResponse(text);
  // Todoist may omit the scope on a refresh; keep what the grant actually has.
  if (!next.scope) next.scope = token.scope;
  // A rotation that returns no new refresh token leaves the old one valid.
  if (!next.refresh_token) next.refresh_token = token.refresh_token;
  saveToken(next);
  log(`todoist-oauth: refreshed, valid until ${next.expires_at ?? "(no expiry)"}`);
  audit({
    action: "todoist-oauth", actor: "aibroker", target: "aibroker",
    outcome: "refreshed", meta: { scope: next.scope },
  });
  return next;
}

/**
 * The token to use right now, refreshed if it is about to expire.
 *
 * Every caller should go through this rather than `loadToken()`: an hour is
 * short enough that "it worked when I tested it" proves nothing.
 */
/**
 * The refresh in flight, if any.
 *
 * Todoist ROTATES refresh tokens and treats a second use of one as an attack:
 * presenting a spent refresh token returns `invalid_grant — refresh token reuse
 * detected` and REVOKES THE ENTIRE GRANT, not just that token. Re-authorising is
 * then the only way back, and it needs a human at a browser.
 *
 * Which makes concurrent refresh a loaded gun. Several callers — the webhook
 * dispatcher, the comment mirror's timer, a session replying — routinely ask for
 * a token in the same moment. If the token has just expired they each see it
 * expired, each fire a refresh with the same stored refresh token, the first
 * rotates it, and every straggler presents a spent one. The grant dies.
 *
 * That is not hypothetical: it happened on 2026-08-03 at 13:50, minutes after
 * the five-minute mirror timer was added and while the daemon was being
 * restarted repeatedly. Everything Todoist stopped working and the only symptom
 * was 401s.
 *
 * So: one refresh at a time, and everyone else waits for its result.
 */
let refreshing: Promise<StoredToken> | undefined;

export async function getAccessToken(fetchImpl: typeof fetch = fetch): Promise<StoredToken | null> {
  const t = loadToken();
  if (!t) return null;
  if (!isExpired(t)) return t;

  const clientId = process.env.TODOIST_CLIENT_ID;
  const clientSecret = process.env.TODOIST_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    log("todoist-oauth: token expired and cannot refresh — TODOIST_CLIENT_ID/SECRET not set");
    return t;
  }
  try {
    if (!refreshing) {
      // Re-read inside the guard: a refresh that completed while we were
      // deciding has already written a fresh token to disk, and refreshing the
      // one we loaded a moment ago would spend a token that is already spent.
      refreshing = (async () => {
        const current = loadToken() ?? t;
        if (!isExpired(current)) return current;
        return refreshAccessToken(clientId, clientSecret, current, fetchImpl);
      })().finally(() => { refreshing = undefined; });
    }
    return await refreshing;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    log(`todoist-oauth: refresh failed — ${reason}`);
    audit({
      action: "todoist-oauth", actor: "aibroker", target: "aibroker",
      outcome: "failed", reason: `refresh failed — ${reason}`,
    });
    return t; // let the caller's 401 speak for itself rather than inventing one
  }
}

function page(title: string, detail: string, ok: boolean): string {
  const accent = ok ? "#2d7a4b" : "#a33";
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>
 body{font:16px/1.5 -apple-system,system-ui,sans-serif;margin:0;display:grid;place-items:center;height:100vh;background:#faf9f7;color:#1a1a1a}
 main{max-width:34rem;padding:2rem}
 h1{font-size:1.3rem;margin:0 0 .6rem;color:${accent}}
 p{margin:.4rem 0;color:#444}
 code{background:#eee;padding:.1rem .3rem;border-radius:3px;font-size:.9em}
 @media(prefers-color-scheme:dark){body{background:#141414;color:#eee}p{color:#bbb}code{background:#2a2a2a}}
</style>
<main><h1>${title}</h1><p>${detail}</p></main>`;
}

export interface OAuthDeps {
  clientId?: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
}

/**
 * Handle the redirect Todoist sends the browser to.
 *
 * Always answers with a readable page — this is the one endpoint here a human
 * looks at directly, and "404" taught the last person to debug it nothing.
 */
export async function handleOAuthCallback(
  url: URL,
  deps: OAuthDeps,
): Promise<{ status: number; html: string }> {
  const fail = (status: number, title: string, detail: string, reason: string) => {
    audit({ action: "todoist-oauth", actor: "todoist", target: "aibroker", outcome: "failed", reason });
    log(`todoist-oauth: ${reason}`);
    return { status, html: page(title, detail, false) };
  };

  const denied = url.searchParams.get("error");
  if (denied) {
    return fail(400, "Authorisation declined", `Todoist reported <code>${denied}</code>. Nothing was changed.`,
      `authorisation declined by Todoist: ${denied}`);
  }

  const code = url.searchParams.get("code");
  if (!code) {
    return fail(400, "Nothing to exchange",
      "This is the OAuth landing for the AIBroker Todoist bridge. It expects a <code>code</code> from Todoist; " +
      "opening it directly does nothing. Start with <code>aibroker todoist auth</code>.",
      "callback carried no code");
  }

  if (!deps.clientId) {
    return fail(500, "Not configured",
      "Set <code>TODOIST_CLIENT_ID</code> in <code>~/.aibroker/env</code> and restart the daemon — " +
      "the exchange cannot be made without it.",
      "TODOIST_CLIENT_ID is not set");
  }

  const state = consumeState(url.searchParams.get("state"));
  if (!state.ok) {
    return fail(400, "Unexpected callback", state.reason, `state check failed: ${state.reason}`);
  }

  try {
    const token = await exchangeCode(deps.clientId, deps.clientSecret, code, deps.fetchImpl);
    saveToken(token);
    audit({
      action: "todoist-oauth", actor: "todoist", target: "aibroker", outcome: "authorized",
      // The token itself is never recorded — only that one was obtained, and for what.
      meta: { scope: token.scope },
    });
    log(`todoist-oauth: authorised, scope ${token.scope ?? "(unreported)"}`);
    return {
      status: 200,
      html: page("Authorised",
        `AIBroker can now act on this Todoist account${token.scope ? ` with <code>${token.scope}</code>` : ""}. ` +
        "Webhooks will be delivered from now on. You can close this tab.", true),
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return fail(502, "Exchange failed", reason, reason);
  }
}
