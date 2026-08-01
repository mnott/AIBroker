/**
 * test/todoist-oauth.test.ts — the OAuth landing the redirect URL serves.
 *
 * This endpoint exists because Todoist will not deliver webhooks to the account
 * that created the app until that account completes an OAuth round trip. It is
 * reachable by anything that can reach the redirect URL, and it spends the
 * client secret, so the interesting cases are the ones where it must refuse:
 * a callback with no pending authorisation behind it, a stale one, and one
 * carrying a state we never issued.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The module resolves ~/.aibroker at import time via homedir(), so point HOME
// at a scratch directory before importing it. Nothing here touches the real one.
const scratch = mkdtempSync(join(tmpdir(), "aibroker-oauth-"));
process.env.HOME = scratch;
mkdirSync(join(scratch, ".aibroker"), { recursive: true });

const {
  beginAuth,
  consumeState,
  authorizeUrl,
  exchangeCode,
  handleOAuthCallback,
  loadToken,
  saveToken,
  isExpired,
  refreshAccessToken,
  getAccessToken,
} = await import("../src/daemon/todoist-oauth.js");
import type { StoredToken } from "../src/daemon/todoist-oauth.js";

const PENDING = join(scratch, ".aibroker", "todoist-oauth-pending.json");
const TOKEN = join(scratch, ".aibroker", "todoist-oauth.json");

function cleanup(): void {
  for (const f of [PENDING, TOKEN]) if (existsSync(f)) rmSync(f);
}

test("authorizeUrl carries client id, scope and state", () => {
  const url = new URL(authorizeUrl("cid", "data:read_write", "st8"));
  assert.equal(url.origin + url.pathname, "https://todoist.com/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), "cid");
  assert.equal(url.searchParams.get("scope"), "data:read_write");
  assert.equal(url.searchParams.get("state"), "st8");
});

test("state round-trips once and only once", () => {
  cleanup();
  const state = beginAuth();
  assert.equal(consumeState(state).ok, true);
  // Replaying the same callback must not authorise a second time.
  const replay = consumeState(state);
  assert.equal(replay.ok, false);
});

test("a callback with no pending authorisation is refused", () => {
  cleanup();
  const r = consumeState("anything");
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /no authorisation is in progress/);
});

test("a mismatched state is refused and does not consume the pending one", () => {
  cleanup();
  beginAuth();
  assert.equal(consumeState("not-the-state").ok, false);
  // The real callback can still land — a wrong guess must not lock the user out.
  assert.equal(existsSync(PENDING), true);
});

test("an expired attempt is refused", () => {
  cleanup();
  writeFileSync(PENDING, JSON.stringify({
    state: "old", created_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
  }), "utf-8");
  const r = consumeState("old");
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /expired/);
});

test("exchangeCode posts form-encoded credentials and returns the token", async () => {
  let seen: { url: string; body: string } | null = null;
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    seen = { url: String(url), body: String(init?.body) };
    return new Response(JSON.stringify({
      access_token: "tok", token_type: "Bearer", scope: "data:read_write",
    }), { status: 200 });
  }) as unknown as typeof fetch;

  const t = await exchangeCode("cid", "secret", "code123", fake);
  assert.equal(t.access_token, "tok");
  assert.equal(t.scope, "data:read_write");
  assert.ok(seen);
  assert.equal(seen!.url, "https://todoist.com/oauth/access_token");
  const sent = new URLSearchParams(seen!.body);
  assert.equal(sent.get("client_secret"), "secret");
  assert.equal(sent.get("code"), "code123");
});

test("exchangeCode surfaces an error body rather than pretending it worked", async () => {
  const fake = (async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(() => exchangeCode("cid", "secret", "bad", fake), /invalid_grant/);
});

test("a bare visit explains itself instead of 404ing", async () => {
  cleanup();
  const r = await handleOAuthCallback(
    new URL("http://x/oauth"), { clientId: "cid", clientSecret: "secret" });
  assert.equal(r.status, 400);
  assert.match(r.html, /Nothing to exchange/);
});

test("a declined authorisation is reported, not swallowed", async () => {
  cleanup();
  const r = await handleOAuthCallback(
    new URL("http://x/oauth?error=access_denied"), { clientId: "cid", clientSecret: "secret" });
  assert.equal(r.status, 400);
  assert.match(r.html, /access_denied/);
});

test("a code arriving with no pending state is not exchanged", async () => {
  cleanup();
  let called = false;
  const fake = (async () => { called = true; return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
  const r = await handleOAuthCallback(
    new URL("http://x/oauth?code=c&state=forged"),
    { clientId: "cid", clientSecret: "secret", fetchImpl: fake });
  assert.equal(r.status, 400);
  assert.equal(called, false, "the secret must not be spent on an unsolicited callback");
});

test("a complete round trip stores the token and says so", async () => {
  cleanup();
  const state = beginAuth();
  const fake = (async () => new Response(JSON.stringify({
    access_token: "tok", token_type: "Bearer", scope: "data:read_write",
  }), { status: 200 })) as unknown as typeof fetch;

  const r = await handleOAuthCallback(
    new URL(`http://x/oauth?code=c&state=${state}`),
    { clientId: "cid", clientSecret: "secret", fetchImpl: fake });

  assert.equal(r.status, 200);
  assert.match(r.html, /Authorised/);
  const stored = loadToken();
  assert.equal(stored?.access_token, "tok");
  // The page is shown to a human in a browser; it must not print the credential.
  assert.equal(r.html.includes("tok"), false);
});

test("missing client id is reported as configuration, not as a failed exchange", async () => {
  cleanup();
  const r = await handleOAuthCallback(
    new URL("http://x/oauth?code=c&state=s"), { clientSecret: "secret" });
  assert.equal(r.status, 500);
  assert.match(r.html, /TODOIST_CLIENT_ID/);
});

// ── one-hour tokens ─────────────────────────────────────────────────────────
//
// Todoist issues access tokens that live for 3600 seconds, with a refresh
// token that ROTATES on every use. The first version of this module stored
// neither. The result worked perfectly and then stopped about an hour later
// with a 401 that reads exactly like a revoked grant — twice, before anyone
// read the response body closely enough to see what had been discarded.

test("the exchange keeps expiry and refresh token", async () => {
  cleanup();
  const fake = (async () => new Response(JSON.stringify({
    access_token: "a1", token_type: "Bearer", scope: "data:read_write",
    expires_in: 3600, refresh_token: "r1",
  }), { status: 200 })) as unknown as typeof fetch;

  const t = await exchangeCode("cid", "secret", "code", fake);
  assert.equal(t.refresh_token, "r1");
  assert.ok(t.expires_at, "an expiry must be recorded");
  const mins = (Date.parse(t.expires_at!) - Date.now()) / 60000;
  assert.ok(mins > 55 && mins <= 60, `expiry ${mins} min should be about an hour`);
});

test("a token is treated as expired slightly early", () => {
  // A token that expires mid-request is a failed request.
  const soon: StoredToken = {
    access_token: "a", token_type: "Bearer", obtained_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 30_000).toISOString(),
  };
  assert.equal(isExpired(soon), true);

  const fine: StoredToken = { ...soon, expires_at: new Date(Date.now() + 600_000).toISOString() };
  assert.equal(isExpired(fine), false);
});

test("a legacy token with no expiry never looks expired", () => {
  const legacy: StoredToken = {
    access_token: "a", token_type: "Bearer", obtained_at: new Date().toISOString(),
  };
  assert.equal(isExpired(legacy), false);
});

test("refreshing stores the ROTATED refresh token", async () => {
  cleanup();
  saveToken({
    access_token: "old", token_type: "Bearer", obtained_at: new Date().toISOString(),
    refresh_token: "r1", expires_at: new Date(Date.now() - 1000).toISOString(), scope: "data:read_write",
  });
  let sent = "";
  const fake = (async (_u: unknown, init?: RequestInit) => {
    sent = String(init?.body);
    return new Response(JSON.stringify({
      access_token: "new", token_type: "Bearer", expires_in: 3600, refresh_token: "r2",
    }), { status: 200 });
  }) as unknown as typeof fetch;

  const t = await refreshAccessToken("cid", "secret", loadToken()!, fake);
  assert.equal(t.access_token, "new");
  assert.equal(t.refresh_token, "r2", "the old refresh token stops working — the new one must be kept");
  assert.equal(loadToken()?.refresh_token, "r2", "and must be persisted");
  assert.match(sent, /grant_type=refresh_token/);
  assert.equal(t.scope, "data:read_write", "scope survives a refresh that omits it");
});

test("getAccessToken refreshes an expired token without being asked", async () => {
  cleanup();
  process.env.TODOIST_CLIENT_ID = "cid";
  process.env.TODOIST_CLIENT_SECRET = "secret";
  saveToken({
    access_token: "old", token_type: "Bearer", obtained_at: new Date().toISOString(),
    refresh_token: "r1", expires_at: new Date(Date.now() - 1000).toISOString(),
  });
  const fake = (async () => new Response(JSON.stringify({
    access_token: "fresh", token_type: "Bearer", expires_in: 3600, refresh_token: "r2",
  }), { status: 200 })) as unknown as typeof fetch;

  assert.equal((await getAccessToken(fake))?.access_token, "fresh");
});

test("a failed refresh returns the old token rather than inventing a failure", async () => {
  // Let the caller's real 401 speak. Returning null here would report "not
  // authorised" for what may be a transient network problem.
  cleanup();
  saveToken({
    access_token: "old", token_type: "Bearer", obtained_at: new Date().toISOString(),
    refresh_token: "r1", expires_at: new Date(Date.now() - 1000).toISOString(),
  });
  const fake = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
  assert.equal((await getAccessToken(fake))?.access_token, "old");
});
