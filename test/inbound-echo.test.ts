/**
 * test/inbound-echo.test.ts — do not hand a session its own footprint.
 *
 * A session that writes to an issue causes an event on that issue, which comes
 * back through the route as something to consider, which produces another
 * write. The route's `ignore` rule was supposed to prevent this by filtering
 * the account the session posts as, and it cannot do the job whenever the
 * session and the operator share one credential: naming that shared account
 * silences the operator's own comments, which are the reason the route exists,
 * and naming any other account filters nothing at all.
 *
 * Measured live on 2026-09-01, which is why this exists rather than being
 * argued about: a comment written at 11:51:45 arrived back at its own session
 * at 11:51:47, with an `ignore` rule in place that looked correct.
 *
 * So the test is of the question actually asked — "did we just do this" —
 * rather than of who signed it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { shouldIgnore, noteOwnWrite, forgetOwnWrites } from "../src/daemon/inbound.js";

const route = (ignore?: string[]) =>
  ({ name: "a-tracker", owner: "a-session", mode: "message", ignore }) as any;

const named = (name: string) => ({ name, owner: "a-session", mode: "message" }) as any;

const event = (issue: number, sender: string) => ({
  action: "created",
  issue: { number: issue },
  sender: { login: sender },
});

/** What a forge actually posts: the repository is in every copy of the event. */
const forgeEvent = (repo: string, issue: number, sender: string) => ({
  ...event(issue, sender),
  repository: { full_name: repo },
});

test("the echo of our own write is dropped, whoever the forge says signed it", () => {
  forgetOwnWrites();
  const r = route();
  noteOwnWrite("a-tracker", 2);
  // Same account as the operator uses — the case no ignore rule can separate.
  assert.match(shouldIgnore(r, event(2, "the-shared-account")) ?? "", /own write to #2/);
});

test("a person writing to a DIFFERENT issue still gets through", () => {
  forgetOwnWrites();
  const r = route();
  noteOwnWrite("a-tracker", 2);
  assert.equal(shouldIgnore(r, event(3, "a-person")), undefined);
});

test("a different route's write does not silence this one", () => {
  forgetOwnWrites();
  noteOwnWrite("another-tracker", 2);
  assert.equal(shouldIgnore(route(), event(2, "a-person")), undefined);
});

test("suppression expires, so the issue does not go deaf", () => {
  forgetOwnWrites();
  const r = route();
  noteOwnWrite("a-tracker", 2);
  assert.ok(shouldIgnore(r, event(2, "x")), "suppressed while fresh");
  // Reach past the window rather than waiting on the clock.
  const real = Date.now;
  try {
    Date.now = () => real() + 120_000;
    assert.equal(shouldIgnore(r, event(2, "x")), undefined, "a later comment on the same issue must arrive");
  } finally {
    Date.now = real;
  }
});

test("an event with no issue number is untouched by this", () => {
  forgetOwnWrites();
  noteOwnWrite("a-tracker", 2);
  assert.equal(shouldIgnore(route(), { action: "ping", sender: { login: "a-person" } }), undefined);
});

test("the handler remembers the issue a verb reports, not only one the caller named", () => {
  /*
   * The gap that let an edited comment echo back. `comment` is given an issue
   * number and `amend` is given a comment id, so a handler that only looks at
   * what the CALLER passed remembers nothing for amend — and what it cannot
   * name, it cannot suppress. Measured before and after on a live route:
   *
   *   12:11:14  issue:amend | owner/repo    | ok      (echo delivered)
   *   12:15:59  issue:amend | owner/repo#2  | ok
   *   12:16:00  inbound     | ignored | own write to #2
   *
   * Source-reading, because the wiring lives in a handler that needs a daemon
   * to run; it cannot see the property defeated through a helper it does not
   * recognise. The live readings above are the real evidence.
   */
  const src = readFileSync(new URL("../src/daemon/core-handlers.ts", import.meta.url), "utf8");
  const h = src.slice(src.indexOf('server.on("issue"'));
  const body = h.slice(0, h.indexOf("\n  });"));
  assert.ok(body.length > 0, "handler not found — this check has gone stale");
  assert.match(body, /noteOwnWrite\(/, "a write must be recorded or its echo returns as news");
  // Anchored to the assignment, not merely present somewhere in the handler:
  // an unanchored match found the same text in the audit line and passed a
  // mutation that had removed it from the line that matters.
  assert.match(
    body,
    /const touched\s*=\s*issue \?\? r\.issue/,
    "the verb's own answer must count, not only the caller's argument",
  );
  assert.match(body, /`#\$\{issue \?\? r\.issue\}`/, "and the audit line must name it, which is how this was found at all");
});

test("a SECOND route for the same repository drops the echo too", () => {
  /*
   * The failure this exists for, from the audit trail of 2026-09-02. One
   * repository had two hooks — one added by hand in August, one created by
   * subscribing — and both delivered to the same session. The write was
   * remembered under the route the permission check resolved, so:
   *
   *   19:52:49  inbound hook:owner-repo   ignored   own write to #489
   *   19:52:49  inbound hook:a-tracker  delivered held for grouping
   *
   * The session was told its echo had been suppressed and got it anyway. Both
   * copies name the same repository, so that is what the record is keyed by.
   */
  forgetOwnWrites();
  noteOwnWrite("owner/repo", 489);
  const e = forgeEvent("owner/repo", 489, "the-shared-account");
  assert.match(shouldIgnore(named("derived-name"), e) ?? "", /own write to #489/);
  assert.match(shouldIgnore(named("made-by-hand"), e) ?? "", /own write to #489/, "the older hook delivers the same event");
});

test("a write to one repository does not silence another", () => {
  forgetOwnWrites();
  noteOwnWrite("owner/repo", 7);
  assert.equal(shouldIgnore(named("some-route"), forgeEvent("owner/other", 7, "a-person")), undefined);
});

test("the repository is matched however the forge cases it", () => {
  // The URL a session subscribes with is typed by a person; what the forge
  // sends back is its own spelling. A key that distinguishes them suppresses
  // nothing while looking correct.
  forgetOwnWrites();
  noteOwnWrite("Owner/Repo", 4);
  assert.ok(shouldIgnore(named("a-route"), forgeEvent("owner/repo", 4, "x")));
});

test("the write is recorded against the repository, not the route", () => {
  /*
   * Source-reading, for the same reason as the handler check below: the wiring
   * needs a daemon to run. A record keyed by the route is exactly the bug —
   * it looks right, and it only fails once a repository has a second hook.
   */
  const src = readFileSync(new URL("../src/daemon/core-handlers.ts", import.meta.url), "utf8");
  const h = src.slice(src.indexOf('server.on("issue"'));
  const body = h.slice(0, h.indexOf("\n  });"));
  assert.match(
    body,
    /noteOwnWrite\(`\$\{ref\.owner\}\/\$\{ref\.repo\}`/,
    "keyed by the repository written to, so every hook carrying it suppresses the echo",
  );
});

test("subscribing does not filter the account the token posts as", () => {
  /*
   * It did, and that account is the operator's own whenever the credential is
   * shared — so the rule dropped the operator's comments, which are the reason
   * the route exists. From the trail of 2026-09-02, twice inside ten seconds:
   *
   *   08:37:37  inbound hook:owner-repo  ignored  sender.login=<operator>
   *
   * The loop is stopped by the write record instead, which does not care who
   * signed anything.
   */
  const src = readFileSync(new URL("../src/daemon/core-handlers.ts", import.meta.url), "utf8");
  const h = src.slice(src.indexOf('server.on("subscribe_issues"'));
  const body = h.slice(0, h.indexOf("\n  });"));
  assert.ok(body.length > 0, "handler not found — this check has gone stale");
  assert.doesNotMatch(body, /ignore:\s*\w+\s*\?\s*\[`sender\.login=/, "a self-ignore here silences the operator");
});

test("the configured ignore rules still apply on top", () => {
  forgetOwnWrites();
  const r = route(["sender.login=a-bot"]);
  assert.equal(shouldIgnore(r, event(9, "a-bot")), "sender.login=a-bot");
  assert.equal(shouldIgnore(r, event(9, "a-person")), undefined);
});
