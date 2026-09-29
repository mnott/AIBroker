import "./home-guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { enumerationStep, ENUMERATION_ALERT_AFTER_MS, type EnumerationEpisode } from "../src/daemon/manage.js";

const TICK = 20_000;

/** Runs ticks of the given reliability from t0; returns the actions and the final state. */
function run(ep: EnumerationEpisode, t0: number, ticks: number, reliable: boolean) {
  const actions: string[] = [];
  let now = t0;
  for (let i = 0; i < ticks; i++, now += TICK) {
    const s = enumerationStep(ep, now, reliable);
    ep = s.ep;
    actions.push(s.action);
  }
  return { ep, actions, now };
}

const count = (a: string[], x: string) => a.filter((y) => y === x).length;
const fresh = (): EnumerationEpisode => ({ since: null, alerted: false });

test("a single failed tick then recovery raises nothing", () => {
  const f = run(fresh(), 0, 1, false);
  const r = run(f.ep, f.now, 1, true);
  assert.deepEqual([...f.actions, ...r.actions], ["none", "none"]);
});

test("a failure sustained past the threshold alerts exactly once", () => {
  const ticks = (ENUMERATION_ALERT_AFTER_MS / TICK) * 3;
  const f = run(fresh(), 0, ticks, false);
  assert.equal(count(f.actions, "alert"), 1);
  assert.equal(f.actions.indexOf("alert"), ENUMERATION_ALERT_AFTER_MS / TICK);
});

test("recovery after an alert yields exactly one recovered", () => {
  const f = run(fresh(), 0, 10, false);
  const r = run(f.ep, f.now, 3, true);
  assert.deepEqual(r.actions, ["recovered", "none", "none"]);
});

test("a second episode alerts only after its own threshold", () => {
  const a = run(fresh(), 0, 10, false);
  const ok = run(a.ep, a.now, 1, true);
  const b = run(ok.ep, ok.now, 10, false);
  const early = b.actions.slice(0, ENUMERATION_ALERT_AFTER_MS / TICK);
  assert.equal(count(early, "alert"), 0);
  assert.equal(count(b.actions, "alert"), 1);
});
