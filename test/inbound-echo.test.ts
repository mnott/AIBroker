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
import { shouldIgnore, noteOwnWrite, forgetOwnWrites } from "../src/daemon/inbound.js";

const route = (ignore?: string[]) =>
  ({ name: "a-tracker", owner: "a-session", mode: "message", ignore }) as any;

const event = (issue: number, sender: string) => ({
  action: "created",
  issue: { number: issue },
  sender: { login: sender },
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

test("the configured ignore rules still apply on top", () => {
  forgetOwnWrites();
  const r = route(["sender.login=a-bot"]);
  assert.equal(shouldIgnore(r, event(9, "a-bot")), "sender.login=a-bot");
  assert.equal(shouldIgnore(r, event(9, "a-person")), undefined);
});
