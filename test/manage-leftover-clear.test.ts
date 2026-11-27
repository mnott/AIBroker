import "./home-guard.js";
/**
 * Leftover input-line text that Ctrl-U cannot clear (Capgemini, 2026-11-27:
 * 425 identical alerts, never armed): fallback clears or resolves it, and
 * alerts are de-duplicated.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  clearInputResolving, looksMachineTyped, leftoverMayRetry, leftoverFailed, resetLeftoverState, type ClearResolveDeps,
} from "../src/daemon/manage.js";

beforeEach(() => resetLeftoverState());

/** Fake terminal: Ctrl-U is inert; behaviour of the other keys is configurable. */
function term(text: string, o: { strong?: boolean; enter?: boolean; bs?: boolean }) {
  const st = { text, saved: [] as string[], keys: [] as string[] };
  const deps: ClearResolveDeps = {
    read: async () => st.text,
    sleep: async () => {},
    ctrlU: () => { st.keys.push("ctrl-u"); },
    strongClear: () => { st.keys.push("strong"); if (o.strong) st.text = ""; },
    backspaces: () => { st.keys.push("bs"); if (o.bs) st.text = ""; },
    enter: () => { st.keys.push("enter"); if (o.enter) st.text = ""; },
    save: (t, how) => { st.saved.push(`${how}:${t}`); },
  };
  return { st, deps };
}

test("strong clear (End+Ctrl-U / Esc Esc) clears what Ctrl-U cannot", async () => {
  const t = term("yes create the Rolodex developer app", { strong: true });
  const r = await clearInputResolving(t.deps);
  assert.deepEqual(r, { empty: true, how: "strong" });
  assert.deepEqual(t.st.saved, []);
});

test("human draft that survives everything is saved then submitted", async () => {
  const t = term("yes create the Rolodex developer app", { enter: true });
  const r = await clearInputResolving(t.deps);
  assert.equal(r.empty && r.how, "submitted");
  assert.deepEqual(t.st.saved, ["submitted:yes create the Rolodex developer app"]);
  assert.ok(!t.st.keys.includes("bs"));
});

test("machine text is saved then deleted, never submitted", async () => {
  const t = term("/goal do things", { bs: true, enter: true });
  const r = await clearInputResolving(t.deps);
  assert.equal(r.empty && r.how, "deleted");
  assert.deepEqual(t.st.saved, ["deleted:/goal do things"]);
  assert.ok(!t.st.keys.includes("enter"));
  assert.ok(looksMachineTyped("[Session:A] hi"));
  assert.ok(!looksMachineTyped("yes create it"));
});

test("nothing works: reported not-empty", async () => {
  const r = await clearInputResolving(term("stuck", {}).deps);
  assert.deepEqual(r, { empty: false, remaining: "stuck" });
});

test("N retries of the same leftover alert exactly once, with back-off", () => {
  let alerts = 0;
  let now = 1_000;
  for (let i = 0; i < 25; i++) {
    if (leftoverMayRetry("S", now)) { if (leftoverFailed("S", "same text", now)) alerts++; }
    now += 20_000;
  }
  assert.equal(alerts, 1);
  assert.equal(leftoverFailed("S", "other text", now), true);
});
