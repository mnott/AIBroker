import "./home-guard.js";
/**
 * test/manage-api-retry.test.ts — the API-retry banner gets a typed
 * keep-alive: one per minute while the banner lasts, uncapped, never over the
 * operator's text, never while paused or after the shift.
 *
 * Observed live 2026-10-17 14:50, the pane read
 *   Goal still active · the API was unavailable or the connection dropped ·
 *   retrying in 1 min (1/3) · send a message to retry now
 * Claude Code retries three times and then gives up; the banner itself says
 * any message retries now. The watcher takes it up.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { API_RETRY, API_RETRY_EVERY_MS, API_RETRY_TEXT, apiRetryNudge } from "../src/daemon/manage.js";
import type { ManagedSession } from "../src/daemon/manage.js";

const NOW = new Date(2026, 9, 17, 14, 50, 0).getTime();
const RULE = "─".repeat(40);

const pane = (banner: boolean, input = "", marker = true) =>
  `${marker ? "◎ /goal active (3m)\n" : ""}` +
  `${banner ? "⏺ Goal still active · the API was unavailable or the connection dropped · retrying in 1 min (1/3) · send a message to retry now\n" : ""}` +
  `● done\n${RULE}\n❯ ${input}\n${RULE}\n`;

const entry = (over: Partial<ManagedSession> = {}): ManagedSession => ({
  sessionId: "s", name: "ApiRetryLeaf", objective: "hold the line", pending: [], history: [],
  lastRearmAt: NOW - 600_000, lastChangeAt: NOW - 60_000, lastHash: "", paused: false,
  startedAt: NOW - 3_600_000, ...over,
});

let typed: string[] = [];
const type = (_id: string, text: string) => { typed.push(text); };

test("the live banner matches the signature; ordinary panes do not", () => {
  assert.equal(API_RETRY.test(pane(true)), true);
  assert.equal(API_RETRY.test("retrying in 2 min (2/3)"), true);
  assert.equal(API_RETRY.test("the API was unavailable or the connection dropped"), true);
  assert.equal(API_RETRY.test(pane(false)), false);
  assert.equal(API_RETRY.test("the connection dropped while downloading"), false);
});

test("banner present: two ticks inside 60 s → one nudge; the tick after 60 s → another", () => {
  typed = [];
  const m = entry();
  assert.equal(apiRetryNudge(m, pane(true), NOW, type), true);
  assert.deepEqual(typed, [API_RETRY_TEXT]);
  assert.equal(apiRetryNudge(m, pane(true), NOW + 30_000, type), false);
  assert.equal(typed.length, 1, "inside the window: no second line");
  assert.equal(apiRetryNudge(m, pane(true), NOW + API_RETRY_EVERY_MS, type), true);
  assert.equal(typed.length, 2, "past the window: another line");
});

test("uncapped: the nudge keeps firing every window for as long as the banner lasts", () => {
  typed = [];
  const m = entry();
  let t = NOW;
  for (let i = 0; i < 10; i++) {
    assert.equal(apiRetryNudge(m, pane(true), t, type), true);
    t += API_RETRY_EVERY_MS;
  }
  assert.equal(typed.length, 10);
});

test("banner + paused: nothing", () => {
  typed = [];
  const m = entry({ paused: true });
  assert.equal(apiRetryNudge(m, pane(true), NOW, type), false);
  assert.equal(typed.length, 0);
  assert.equal(m.lastApiRetryAt, undefined, "nothing recorded");
});

test("banner + shift over: nothing", () => {
  typed = [];
  const m = entry({ shift: { until: NOW - 1, workers: 1, visual: false, startedAt: NOW - 3_600_000 } });
  assert.equal(apiRetryNudge(m, pane(true), NOW, type), false);
  assert.equal(typed.length, 0);
});

test("banner gone: nothing typed — normal rules resume", () => {
  typed = [];
  const m = entry({ lastApiRetryAt: NOW - 10 * 60_000 });
  assert.equal(apiRetryNudge(m, pane(false), NOW, type), false);
  assert.equal(typed.length, 0);
});

test("banner + input line occupied: no typing, no streak — the same tick retries", () => {
  typed = [];
  const m = entry();
  assert.equal(apiRetryNudge(m, pane(true, "half a sentence the operator is typing"), NOW, type), false);
  assert.equal(typed.length, 0);
  assert.equal(m.lastApiRetryAt, undefined, "the window did not move");
  assert.equal(apiRetryNudge(m, pane(true), NOW, type), true, "next tick, clear line: it goes out");
  assert.equal(typed.length, 1);
});

test("the note dedups 5 min while the nudge keeps its own 1/min clock", () => {
  typed = [];
  const m = entry();
  apiRetryNudge(m, pane(true), NOW, type);
  apiRetryNudge(m, pane(true), NOW + API_RETRY_EVERY_MS, type);
  apiRetryNudge(m, pane(true), NOW + 2 * API_RETRY_EVERY_MS, type);
  const notes = () => m.history.filter((h) => h.what.includes("API-retry"));
  assert.equal(notes().length, 1, "one note under the dedup window");
  apiRetryNudge(m, pane(true), NOW + 9 * API_RETRY_EVERY_MS, type);
  assert.equal(notes().length, 2, "a fresh note once the dedup lapses");
  assert.equal(typed.length, 4, "the nudge itself never waited on the note");
});

test("a second nudge does not queue behind a first that never landed — the clock is the m's own", () => {
  typed = [];
  const m = entry({ lastApiRetryAt: NOW - 2 * API_RETRY_EVERY_MS });
  assert.equal(apiRetryNudge(m, pane(true), NOW, type), true, "due immediately");
  assert.equal(apiRetryNudge(m, pane(true), NOW + 1_000, type), false, "and not again inside the window");
});
