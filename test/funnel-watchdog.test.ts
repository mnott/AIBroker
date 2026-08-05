/**
 * test/funnel-watchdog.test.ts — when the watchdog is allowed to pull the lever.
 *
 * Both mistakes it can make are expensive and neither shows up as a crash: a
 * missed outage is silent for hours, and an eager reconnect drops every live
 * tailnet connection to fix nothing. The decision is therefore pure, and this
 * is where it is pinned.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, decide, initialState } from "../src/daemon/funnel-watchdog.js";

const OPTS = { failuresBeforeHeal: 3, healCooldownMs: 900_000, healthyIntervalMs: 300_000, suspectIntervalMs: 30_000 };

// ── reading the probe ────────────────────────────────────────────────────────

test("any HTTP status means the ingress reached the node", () => {
  // 404 from an unmapped path proves as much as 200: the relay got through.
  assert.equal(classify([{ ip: "a", status: 404 }]), "up");
  assert.equal(classify([{ ip: "a", status: 405 }, { ip: "b", status: 405 }]), "up");
});

test("one reachable relay is enough", () => {
  // Observed during recovery: two relays answered while the third still reset.
  // Calling that "down" would bounce a node that is working.
  assert.equal(classify([
    { ip: "a", status: 405 },
    { ip: "b", error: "ECONNRESET" },
  ]), "up");
});

test("every relay refusing is the outage", () => {
  assert.equal(classify([
    { ip: "a", error: "ECONNRESET" },
    { ip: "b", error: "ECONNRESET" },
    { ip: "c", error: "ETIMEDOUT" },
  ]), "down");
});

test("no addresses at all is unknown, not down", () => {
  // Public DNS unreachable means we cannot see, which is not the same as the
  // node being broken.
  assert.equal(classify([]), "unknown");
});

// ── deciding what to do about it ─────────────────────────────────────────────

test("a healthy probe resets the streak and waits", () => {
  const s = initialState();
  s.consecutiveDown = 2;
  s.announced = true;
  const d = decide(s, "up", 1_000, OPTS);
  assert.equal(d.action, "sleep");
  assert.equal(d.sleepMs, 300_000);
  assert.equal(s.consecutiveDown, 0);
  assert.equal(s.announced, false, "a recovered funnel may announce a future outage again");
});

test("one failure never heals — it looks again sooner", () => {
  const s = initialState();
  const d = decide(s, "down", 1_000, OPTS);
  assert.equal(d.action, "sleep");
  assert.equal(d.sleepMs, 30_000, "confirm or clear it quickly");
  assert.equal(s.consecutiveDown, 1);
});

test("the third consecutive failure heals", () => {
  const s = initialState();
  decide(s, "down", 1_000, OPTS);
  decide(s, "down", 2_000, OPTS);
  const d = decide(s, "down", 3_000, OPTS);
  assert.equal(d.action, "heal");
  assert.equal(s.lastHealAt, 3_000);
  assert.equal(s.consecutiveDown, 0, "the streak restarts after the lever is pulled");
});

test("an inconclusive probe breaks the streak rather than building on it", () => {
  // The whole network being down is not a reason to reconnect the node.
  const s = initialState();
  decide(s, "down", 1_000, OPTS);
  decide(s, "down", 2_000, OPTS);
  decide(s, "unknown", 3_000, OPTS);
  const d = decide(s, "down", 4_000, OPTS);
  assert.equal(d.action, "sleep", "two failures either side of a blind spot are not three failures");
  assert.equal(s.consecutiveDown, 1);
});

test("a reconnect that did not help is not repeated", () => {
  const s = initialState();
  s.lastHealAt = 1_000;
  s.consecutiveDown = 2;
  const d = decide(s, "down", 1_000 + 60_000, OPTS);
  assert.equal(d.action, "sleep", "inside the cooldown the lever stays untouched");
  assert.match(d.reason, /did not fix it/);
});

test("after the cooldown it may try once more", () => {
  const s = initialState();
  s.lastHealAt = 1_000;
  s.consecutiveDown = 2;
  const d = decide(s, "down", 1_000 + 900_001, OPTS);
  assert.equal(d.action, "heal");
});

test("a long healthy stretch cannot accumulate into a bounce", () => {
  const s = initialState();
  for (let i = 0; i < 50; i++) {
    decide(s, "down", i * 1_000, OPTS);
    const d = decide(s, "up", i * 1_000 + 500, OPTS);
    assert.equal(d.action, "sleep");
  }
  assert.equal(s.lastHealAt, undefined, "never healed across 50 isolated failures");
});
