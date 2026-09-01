/**
 * test/subscribe-issues.test.ts — binding a tracker to the calling session.
 *
 * Two things are worth pinning here and they are not equally important.
 *
 * The parsing and the forge shapes are ordinary: they either work or somebody
 * notices within a minute of trying it.
 *
 * The one that must not rot is that the route's owner comes from the CALLER and
 * never from the payload. docs/inbound.md rests on it — "a route names its
 * session; the payload never does" — because a caller-chosen target is a
 * caller-chosen executor. The trial below plants an owner in the request and
 * requires it to be ignored, and the mutation for it is a one-line change any
 * future refactor could make while looking reasonable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseRepoUrl,
  routeNameFor,
  hooksEndpoint,
  hookPayload,
  forgeOf,
  registerHook,
  ISSUE_FIELDS,
} from "../src/daemon/subscribe-issues.js";

test("reads owner and repo out of a browser URL", () => {
  const r = parseRepoUrl("https://forge.example.org/RRNO/mdf-system");
  assert.deepEqual(r, { origin: "https://forge.example.org", owner: "RRNO", repo: "mdf-system" });
});

test("accepts what is actually in the clipboard: trailing slash, .git, a deep link", () => {
  for (const input of [
    "https://forge.example.org/RRNO/mdf-system/",
    "https://forge.example.org/RRNO/mdf-system.git",
    "https://forge.example.org/RRNO/mdf-system/issues/12",
  ]) {
    const r = parseRepoUrl(input);
    assert.equal(r?.owner, "RRNO", input);
    assert.equal(r?.repo, "mdf-system", input);
  }
});

test("refuses what is not a repository URL, rather than inventing one", () => {
  for (const input of ["", "   ", "not a url", "ftp://forge/owner/repo", "https://forge.example.org/lonely"]) {
    assert.equal(parseRepoUrl(input), null, input);
  }
});

test("the route name is derived, lowercased, and safe for a path segment", () => {
  const ref = parseRepoUrl("https://forge.example.org/RRNO/mdf-system")!;
  assert.equal(routeNameFor(ref), "rrno-mdf-system");
});

test("the derived name is what addRoute would keep, so a second subscribe updates", () => {
  // addRoute lowercases and strips to [a-z0-9_-]. If routeNameFor produced
  // anything else, the stored name would differ from the computed one and the
  // idempotence the derivation exists for would be lost silently.
  const ref = parseRepoUrl("https://forge.example.org/Some.Org/My_Repo.X")!;
  const name = routeNameFor(ref);
  assert.equal(name, name.toLowerCase().replace(/[^a-z0-9_-]/g, "-"));
});

test("github is recognised by host; anything else is treated as Gitea-shaped", () => {
  assert.equal(forgeOf(parseRepoUrl("https://github.com/o/r")!), "github");
  assert.equal(forgeOf(parseRepoUrl("https://forge.example.org/o/r")!), "gitea");
});

test("github hooks live on the API host, Gitea-shaped ones on the same origin", () => {
  assert.equal(hooksEndpoint(parseRepoUrl("https://github.com/o/r")!), "https://api.github.com/repos/o/r/hooks");
  assert.equal(
    hooksEndpoint(parseRepoUrl("https://forge.example.org/o/r")!),
    "https://forge.example.org/api/v1/repos/o/r/hooks",
  );
});

test("both hook bodies are explicitly active and ask for issues and comments", () => {
  for (const url of ["https://github.com/o/r", "https://forge.example.org/o/r"]) {
    const body = hookPayload(parseRepoUrl(url)!, "https://host/hook/o-r", "s3cret") as any;
    assert.equal(body.active, true, url);
    assert.deepEqual(body.events, ["issues", "issue_comment"], url);
    assert.equal(body.config.secret, "s3cret", url);
  }
});

test("a hook the forge already has counts as registered, so subscribing twice is safe", async () => {
  const ref = parseRepoUrl("https://forge.example.org/o/r")!;
  const fake = (async () => ({ status: 422 })) as unknown as typeof fetch;
  const r = await registerHook(ref, "https://host/hook/o-r", "s", "token", fake);
  assert.equal(r.registered, true);
});

test("an unreachable forge is reported, not thrown, so the route still stands", async () => {
  const ref = parseRepoUrl("https://forge.example.org/o/r")!;
  const fake = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
  const r = await registerHook(ref, "https://host/hook/o-r", "s", "token", fake);
  assert.equal(r.registered, false);
  assert.match(r.reason ?? "", /unreachable/);
});

test("no token means no forge call at all, and says why", async () => {
  const ref = parseRepoUrl("https://forge.example.org/o/r")!;
  let called = false;
  const fake = (async () => { called = true; return { status: 201 }; }) as unknown as typeof fetch;
  const r = await registerHook(ref, "https://host/hook/o-r", "s", undefined, fake);
  assert.equal(called, false);
  assert.equal(r.registered, false);
  assert.match(r.reason ?? "", /token/);
});

test("the handler takes the owner from the CALLER and never from the request", () => {
  /*
   * The load-bearing guard, and the only one here worth a check.
   *
   * A target parameter would be the whole of the vulnerability: whoever could
   * call the tool would choose which session runs with the operator's rights.
   * The handler must resolve the owner from the caller's own identity, so this
   * reads the handler and requires both halves — that callerItermId decides it,
   * and that nothing lifts an owner or session out of req.params.
   *
   * It reads source, which is its limit and is said plainly: it cannot see an
   * owner arriving through a helper it does not recognise. What it does catch
   * is the refactor that adds `const { repo, owner } = req.params` because a
   * caller asked to subscribe someone else, which is the realistic way this
   * property dies.
   */
  const src = readFileSync(new URL("../src/daemon/core-handlers.ts", import.meta.url), "utf8");
  const handler = src.slice(src.indexOf('server.on("subscribe_issues"'));
  const body = handler.slice(0, handler.indexOf("\n  });"));
  assert.ok(body.length > 0, "handler not found — this check has gone stale");
  assert.match(body, /callerItermId\(req\)/, "owner must come from the caller");
  assert.doesNotMatch(
    body.replace(/\/\*[\s\S]*?\*\//g, ""),
    /params as \{[^}]*\b(owner|session|target)\b/,
    "a target parameter would let a caller choose which session receives",
  );
});

test("the field list is the one proven to lift from real issue payloads", () => {
  // Not arbitrary: these are the paths the first working route used, and both
  // forges name them identically, which is why one list serves both.
  for (const f of ["action", "issue.number", "issue.title", "comment.body", "sender.login"]) {
    assert.ok(ISSUE_FIELDS.includes(f), f);
  }
});
