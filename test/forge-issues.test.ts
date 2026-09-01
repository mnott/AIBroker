/**
 * test/forge-issues.test.ts — the tracker, for a session that receives from it.
 *
 * Three properties earn a check here, and they were all learned somewhere else
 * first — in a sibling project's script that has been doing this daily.
 *
 * A write reads itself back, and says so when it cannot. A network call returns
 * and carries on; a post that failed while the caller believed it succeeded is
 * invisible until somebody needs what it said.
 *
 * A listing is all of it. The forge answers fifty and says nothing about the
 * rest, and "no more open issues" is exactly the false reading somebody acts on.
 *
 * 404 is ambiguous and must say so. It means both "no such issue" and "your
 * token cannot see this", and reporting the first when it is the second sends a
 * reader hunting a missing thing that is merely locked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { issueOp, explain, authHeader, apiRoot, forgetIdentities, sign, unsign, READ_VERBS, WRITE_VERBS } from "../src/daemon/forge-issues.js";
import { parseRepoUrl } from "../src/daemon/subscribe-issues.js";

const REF = parseRepoUrl("https://forge.example.org/o/r")!;

/** A forge that answers a scripted sequence and records what it was asked. */
function forge(steps: Array<{ status: number; json?: unknown }>) {
  const seen: Array<{ method: string; url: string }> = [];
  const sentBodies: string[] = [];
  let i = 0;
  const impl = (async (url: string, init?: any) => {
    seen.push({ method: init?.method ?? "GET", url: String(url) });
    if (init?.body) sentBodies.push(String(init.body));
    const step = steps[Math.min(i++, steps.length - 1)];
    return { status: step.status, json: async () => step.json, text: async () => "" };
  }) as unknown as typeof fetch;
  return { impl, seen, sentBodies };
}

test("a comment is read back, and what the server holds is what is returned", async () => {
  const f = forge([
    { status: 201, json: { id: 7, html_url: "https://forge/x#7" } },
    { status: 200, json: [{ id: 7, body: "as stored", html_url: "https://forge/x#7" }] },
  ]);
  const r = await issueOp("comment", { issue: 3, body: "hello" }, { ref: REF, token: "t", fetchImpl: f.impl });
  assert.equal(r.ok, true);
  assert.equal(r.url, "https://forge/x#7");
  assert.deepEqual(r.data, { body: "as stored" });
  assert.equal(f.seen[1].method, "GET", "the second call must be the read-back");
});

test("a post that cannot be read back is reported UNCONFIRMED, not as success", async () => {
  const f = forge([
    { status: 201, json: { id: 7, html_url: "https://forge/x#7" } },
    { status: 500 },
  ]);
  const r = await issueOp("comment", { issue: 3, body: "hello" }, { ref: REF, token: "t", fetchImpl: f.impl });
  assert.equal(r.ok, true);
  assert.match(r.warning ?? "", /unconfirmed/i);
});

test("an empty comment is refused before it reaches the forge", async () => {
  const f = forge([{ status: 201 }]);
  const r = await issueOp("comment", { issue: 3, body: "   " }, { ref: REF, token: "t", fetchImpl: f.impl });
  assert.equal(r.ok, false);
  assert.equal(f.seen.length, 0, "nothing should have been sent");
});

test("a listing pages past the first fifty rather than stopping silently", async () => {
  const page = (n: number, count: number) =>
    Array.from({ length: count }, (_, k) => ({ number: n * 100 + k, title: "t", user: { login: "a" } }));
  const f = forge([
    { status: 200, json: page(1, 50) },
    { status: 200, json: page(2, 50) },
    { status: 200, json: page(3, 7) },
  ]);
  const r = await issueOp("list", {}, { ref: REF, token: "t", fetchImpl: f.impl });
  assert.equal(r.ok, true);
  assert.equal((r.data as unknown[]).length, 107, "a listing that stops at 50 looks like a complete answer");
});

test("a listing says who opened each issue, because that decides who may close it", async () => {
  const f = forge([{ status: 200, json: [{ number: 1, title: "t", user: { login: "someone" }, labels: [] }] }]);
  const r = await issueOp("list", {}, { ref: REF, token: "t", fetchImpl: f.impl });
  assert.equal((r.data as any[])[0].opened_by, "someone");
});

test("closing somebody else's issue is refused, with what to do instead", async () => {
  forgetIdentities();
  const f = forge([{ status: 200, json: { number: 4, user: { login: "a-person" } } }, { status: 200, json: { login: "the-bot" } }]);
  const r = await issueOp("close", { issue: 4 }, { ref: REF, token: "t", botLogin: "the-bot", fetchImpl: f.impl });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /opened by a-person/);
  assert.match(r.error ?? "", /leave the tick/);
});

test("closing an issue this account opened is allowed, and read back", async () => {
  forgetIdentities();
  const f = forge([
    { status: 200, json: { number: 4, user: { login: "the-bot" } } },
    { status: 200, json: { login: "the-bot" } },
    { status: 200, json: {} },
    { status: 200, json: { number: 4, state: "closed", html_url: "https://forge/4" } },
  ]);
  const r = await issueOp("close", { issue: 4 }, { ref: REF, token: "t", botLogin: "the-bot", fetchImpl: f.impl });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, { state: "closed" });
});

test("claiming work already assigned to somebody else is refused", async () => {
  forgetIdentities();
  const f = forge([{ status: 200, json: { login: "the-bot" } }, { status: 200, json: { number: 4, assignees: [{ login: "a-person" }] } }]);
  const r = await issueOp("claim", { issue: 4 }, { ref: REF, token: "t", botLogin: "the-bot", fetchImpl: f.impl });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /not yours to take/);
});

test("identity comes from the FORGE, not from the configured name", async () => {
  /*
   * The fault this exists for, measured live on 2026-09-01: the configured name
   * said one account and the token belonged to another. Nothing checked, so the
   * self-ignore filtered a login that never arrived and a session's own comment
   * came back to it two seconds after the write.
   *
   * Here the forge says "really-me" while the configuration insists on
   * "the-bot". The forge wins: an issue opened by really-me may be closed, and
   * the configured name has no say in it.
   */
  forgetIdentities();
  const f = forge([
    { status: 200, json: { number: 4, user: { login: "really-me" } } },
    { status: 200, json: { login: "really-me" } },
    { status: 200, json: {} },
    { status: 200, json: { number: 4, state: "closed", html_url: "https://forge/4" } },
  ]);
  const r = await issueOp("close", { issue: 4 }, { ref: REF, token: "t", botLogin: "the-bot", fetchImpl: f.impl });
  assert.equal(r.ok, true, "the token's real account opened it, so it may close it");
});

test("the configured name is used only when the forge will not say", async () => {
  forgetIdentities();
  const f = forge([
    { status: 200, json: { number: 4, user: { login: "the-bot" } } },
    { status: 401 },                                   // forge refuses to identify the credential
    { status: 200, json: {} },
    { status: 200, json: { number: 4, state: "closed", html_url: "https://forge/4" } },
  ]);
  const r = await issueOp("close", { issue: 4 }, { ref: REF, token: "t", botLogin: "the-bot", fetchImpl: f.impl });
  assert.equal(r.ok, true, "falls back rather than becoming unusable");
});

test("with no configured name and a silent forge, close refuses rather than guessing", async () => {
  forgetIdentities();
  const f = forge([
    { status: 200, json: { number: 4, user: { login: "someone" } } },
    { status: 401 },
  ]);
  const r = await issueOp("close", { issue: 4 }, { ref: REF, token: "t", fetchImpl: f.impl });
  assert.equal(r.ok, false);
});

test("a label that does not exist is refused rather than invented", async () => {
  const f = forge([{ status: 200, json: [{ id: 1, name: "bug" }] }]);
  const r = await issueOp("label", { issue: 4, label: "urgent" }, { ref: REF, token: "t", fetchImpl: f.impl });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /created by a person/);
});

test("get returns chosen fields, and carries no email address out of the forge", async () => {
  // The forge nests a whole user record under `user`. Handing it back puts a
  // person's email into a session's context, and from there into whatever that
  // session writes next. Measured against the shape a live Forgejo returned.
  const f = forge([{
    status: 200,
    json: {
      number: 2, title: "t", state: "open", body: "b", html_url: "https://forge/2",
      user: { login: "someone", email: "someone@example.org", avatar_url: "https://forge/a" },
      labels: [{ name: "bug" }], assignees: [{ login: "someone" }],
    },
  }]);
  const r = await issueOp("get", { issue: 2 }, { ref: REF, token: "t", fetchImpl: f.impl });
  const flat = JSON.stringify(r.data);
  assert.doesNotMatch(flat, /@example\.org/, "an email address must not travel with an issue");
  assert.doesNotMatch(flat, /avatar/, "the raw user record must not be passed through");
  assert.equal((r.data as any).opened_by, "someone");
  assert.deepEqual((r.data as any).labels, ["bug"]);
});

test("comments page too — otherwise 'the newest two' is the 49th and 50th oldest", async () => {
  const page = (n: number, c: number) =>
    Array.from({ length: c }, (_, k) => ({ id: n * 100 + k, body: `c${n * 100 + k}`, user: { login: "a" } }));
  const f = forge([
    { status: 200, json: page(1, 50) },
    { status: 200, json: page(2, 3) },
  ]);
  const r = await issueOp("comments", { issue: 1, count: 2 }, { ref: REF, token: "t", fetchImpl: f.impl });
  assert.deepEqual((r.data as any[]).map((x) => x.body), ["c201", "c202"], "must be the genuinely newest");
});

test("a written comment says which session wrote it", async () => {
  /*
   * Where sessions and the operator share one credential, every comment carries
   * the same author and the tracker keeps no trace of which came from a person.
   * Permission does not care — that rests on the subscription — but a reader in
   * six months has only the ticket.
   */
  const f = forge([
    { status: 201, json: { id: 7, html_url: "https://forge/x#7" } },
    { status: 200, json: [{ id: 7, body: "stored", html_url: "https://forge/x#7" }] },
  ]);
  await issueOp("comment", { issue: 3, body: "Gemessen: ..." },
    { ref: REF, token: "t", authorLabel: "a-session", fetchImpl: f.impl });
  const sent = JSON.parse((f.sentBodies[0] ?? "{}")).body as string;
  assert.match(sent, /Gemessen: \.\.\./, "the author's own text is untouched");
  assert.match(sent, /a-session/, "and it names the session");
  assert.ok(sent.indexOf("Gemessen") < sent.indexOf("a-session"), "appended, not prefixed");
});

test("a rewrite replaces its signature rather than stacking a second", async () => {
  const f = forge([
    { status: 200, json: {} },
    { status: 200, json: { number: 3, body: "x", html_url: "https://forge/3" } },
  ]);
  const once = sign("text", "a-session");
  await issueOp("rewrite", { issue: 3, body: once },
    { ref: REF, token: "t", authorLabel: "a-session", fetchImpl: f.impl });
  const sent = JSON.parse((f.sentBodies[0] ?? "{}")).body as string;
  assert.equal(sent, once, "signing an already-signed body must be idempotent");
  assert.equal(sent.match(/a-session/g)?.length, 1);
});

test("a comment signed by another session may not be edited", async () => {
  /*
   * The forge only lets a credential edit its own comments, and where sessions
   * share one credential that covers everybody's. Sharing an account is not
   * sharing authorship. Found by falling into it: a comment was written under
   * one session's identity by something else entirely, and there was no way to
   * correct the record without adding a third entry three below the mistake.
   */
  forgetIdentities();
  const f = forge([
    { status: 200, json: { body: "text\n\n" + sign("text", "another-session"), user: { login: "shared" } } },
    { status: 200, json: { login: "shared" } },
  ]);
  const r = await issueOp("amend", { comment: 5, body: "corrected" },
    { ref: REF, token: "t", authorLabel: "me", fetchImpl: f.impl });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /signed by "another-session"/);
  assert.match(r.error ?? "", /shared account is not shared authorship/);
});

test("a session may correct its own comment, and it is read back", async () => {
  forgetIdentities();
  const f = forge([
    { status: 200, json: { body: sign("old", "me"), user: { login: "shared" } } },
    { status: 200, json: { login: "shared" } },
    { status: 200, json: {} },
    { status: 200, json: { body: sign("new text", "me"), html_url: "https://forge/c#5" } },
  ]);
  const r = await issueOp("amend", { comment: 5, body: "new text" },
    { ref: REF, token: "t", authorLabel: "me", fetchImpl: f.impl });
  assert.equal(r.ok, true);
  assert.equal(r.url, "https://forge/c#5");
  assert.match((r.data as any).body, /new text/);
  assert.equal((r.data as any).body.match(/me · aibroker/g)?.length, 1, "and not two signatures");
});

test("a comment written by a different ACCOUNT may not be edited either", async () => {
  // The outer of the two custody checks. The signature check catches sessions
  // sharing one account; this catches a genuinely different person, which is
  // the case a forge with several human contributors has all the time.
  forgetIdentities();
  const f = forge([
    { status: 200, json: { body: "a person wrote this, unsigned", user: { login: "a-person" } } },
    { status: 200, json: { login: "shared" } },
  ]);
  const r = await issueOp("amend", { comment: 5, body: "corrected" },
    { ref: REF, token: "t", authorLabel: "me", fetchImpl: f.impl });
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /written by a-person/);
  assert.match(r.error ?? "", /not yours to edit/);
});

test("amend without a comment id is refused before anything is sent", async () => {
  const f = forge([{ status: 200 }]);
  const r = await issueOp("amend", { body: "x" }, { ref: REF, token: "t", fetchImpl: f.impl });
  assert.equal(r.ok, false);
  assert.equal(f.seen.length, 0);
});

test("with no session name nothing is appended", () => {
  assert.equal(sign("text", undefined), "text");
});

test("unsign leaves a body that merely mentions the marker mid-text alone", () => {
  const body = "the 🤖 in line one is part of the sentence";
  assert.equal(unsign(body), body, "only a trailing signature line is a signature");
});

test("404 says it may be permission, not only absence", () => {
  assert.match(explain(404), /does not exist, OR the token cannot see it/);
  assert.match(explain(403), /lacks the access/);
  assert.match(explain(401), /expired/);
});

test("both credential shapes work: an API token, and user:password as Basic", () => {
  assert.equal(authHeader("abc123"), "token abc123");
  assert.match(authHeader("someone:secret"), /^Basic /);
  assert.equal(Buffer.from(authHeader("someone:secret").slice(6), "base64").toString(), "someone:secret");
});

test("no token means nothing is attempted", async () => {
  const f = forge([{ status: 200 }]);
  const r = await issueOp("get", { issue: 1 }, { ref: REF, token: undefined, fetchImpl: f.impl });
  assert.equal(r.ok, false);
  assert.equal(f.seen.length, 0);
});

test("github and Gitea-shaped forges are both addressed correctly", () => {
  assert.equal(apiRoot(parseRepoUrl("https://github.com/o/r")!), "https://api.github.com/repos/o/r");
  assert.equal(apiRoot(REF), "https://forge.example.org/api/v1/repos/o/r");
});

test("the handler allows a verb only where the session already receives", () => {
  /*
   * The permission model, and the reason it cannot widen by accident: writing
   * is allowed exactly where a subscription delivers, and a subscription can
   * only be made by a session for itself. This reads the handler and requires
   * both halves — that a missing route refuses, and that a route belonging to
   * another session refuses too. The second is the one a refactor would drop,
   * because "we already found a route" looks like the check.
   *
   * Source-reading, with the usual limit: it cannot see the property being
   * defeated through a helper it does not recognise.
   */
  const src = readFileSync(new URL("../src/daemon/core-handlers.ts", import.meta.url), "utf8");
  const h = src.slice(src.indexOf('server.on("issue"'));
  const body = h.slice(0, h.indexOf("\n  });"));
  assert.ok(body.length > 0, "handler not found — this check has gone stale");
  assert.match(body, /findRoute\(routeNameFor\(ref\)\)/, "permission must come from the subscription");
  assert.match(body, /route\.owner !== owner/, "a route belonging to another session must refuse");
});

test("every verb the tool offers is one the dispatcher knows", () => {
  // A tool that advertises a verb its implementation drops answers "unknown
  // verb" to something the schema promised.
  const src = readFileSync(new URL("../src/mcp/index.ts", import.meta.url), "utf8");
  const block = src.slice(src.indexOf('"aibroker_issue"'), src.indexOf('"aibroker_subscribe_issues"'));
  const advertised = [...block.matchAll(/"(get|comments|list|labels|assets|new|comment|rewrite|retitle|label|unlabel|claim|release|close)"/g)]
    .map((m) => m[1]);
  const known = new Set<string>([...READ_VERBS, ...WRITE_VERBS]);
  for (const v of new Set(advertised)) assert.ok(known.has(v), `advertised but unknown: ${v}`);
});
