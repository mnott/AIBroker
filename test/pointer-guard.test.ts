/**
 * pointer-guard — a pointer is never typed into an input line holding unsent
 * text; it is retried once the line clears, and dropped once drained.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  typeWhenInputEmpty, resetPointerGuard, GIVEUP_MS, RETRY_MS, HELD_REASON, UNREADABLE_REASON, type GuardDeps,
} from "../src/daemon/pointer-guard.js";

const BOX = (typed: string) => `output\n${"─".repeat(40)}\n❯ ${typed}\n${"─".repeat(40)}\n`;

function fake(pane: () => string | null, mailbox: () => number) {
  let t = 0;
  const timers: Array<{ fn: () => void; at: number; live: boolean }> = [];
  const typed: string[] = [];
  const deps: GuardDeps = {
    read: async () => pane(),
    type: async (_id, text) => { typed.push(text); return "ok"; },
    mailboxSize: mailbox,
    now: () => t,
    sleep: async () => {},
    setTimer: (fn, ms) => { const e = { fn, at: t + ms, live: true }; timers.push(e); return e; },
    clearTimer: (h) => { (h as { live: boolean }).live = false; },
  };
  /** Advance the clock one retry interval and run due timers, letting async work settle. */
  const tick = async () => {
    t += RETRY_MS;
    for (const e of timers.filter((x) => x.live && x.at <= t)) { e.live = false; e.fn(); }
    await new Promise((r) => setImmediate(r));
  };
  return { deps, typed, tick, advance: (ms: number) => { t += ms; } };
}

beforeEach(() => resetPointerGuard());

test("line holds text: not typed, held reason", async () => {
  const f = fake(() => BOX("for local workess"), () => 1);
  const r = await typeWhenInputEmpty("S1", "[Session:A] hi", {}, f.deps);
  assert.deepEqual(r, { typed: false, reason: HELD_REASON });
  assert.deepEqual(f.typed, []);
});

test("empty line: typed once", async () => {
  const f = fake(() => BOX(""), () => 1);
  const r = await typeWhenInputEmpty("S2", "[Session:A] hi", {}, f.deps);
  assert.equal(r.typed, true);
  assert.deepEqual(f.typed, ["[Session:A] hi"]);
});

test("unreadable pane: not typed (fail safe)", async () => {
  const f = fake(() => null, () => 1);
  const r = await typeWhenInputEmpty("S3", "[Session:A] hi", {}, f.deps);
  assert.deepEqual(r, { typed: false, reason: UNREADABLE_REASON });
  assert.deepEqual(f.typed, []);
});

test("retry types once after the line clears; several messages collapse to one pointer", async () => {
  let pane = BOX("half a sentence");
  let n = 1;
  const f = fake(() => pane, () => n);
  const multi = (c: number) => `${c} messages`;
  await typeWhenInputEmpty("S4", "one", { multi }, f.deps);
  n = 2;
  await typeWhenInputEmpty("S4", "two", { multi }, f.deps);
  await f.tick();
  assert.deepEqual(f.typed, [], "still held");
  pane = BOX("");
  await f.tick();
  assert.deepEqual(f.typed, ["2 messages"]);
  await f.tick();
  assert.equal(f.typed.length, 1, "no second pointer");
});

test("drained meanwhile: no retry", async () => {
  let n = 1;
  const f = fake(() => BOX(""), () => n);
  const held = fake(() => BOX("typing"), () => n);
  await typeWhenInputEmpty("S5", "x", {}, held.deps);
  n = 0;
  // line now empty, but the mailbox was drained
  const again = held.deps;
  (again as { read: GuardDeps["read"] }).read = async () => BOX("");
  await held.tick();
  assert.deepEqual(held.typed, []);
  void f;
});

test("gives up after the deadline", async () => {
  const f = fake(() => BOX("typing"), () => 1);
  await typeWhenInputEmpty("S6", "x", {}, f.deps);
  f.advance(GIVEUP_MS);
  await f.tick();
  (f.deps as { read: GuardDeps["read"] }).read = async () => BOX("");
  await f.tick();
  assert.deepEqual(f.typed, []);
});
