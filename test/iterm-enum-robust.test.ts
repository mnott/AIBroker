/**
 * A window, tab or session being closed returns null / throws from the JXA
 * accessors. Every walk must guard each level and skip null entries, and a
 * failed enumeration is retried once before it is reported.
 */
import "./home-guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildItermJxa, withSessionJxa, withEnumRetry, JXA_WALK_PRELUDE } from "../src/adapters/iterm/core.js";

test("walk prelude guards windows, tabs and sessions and skips null entries", () => {
  for (const level of ["app.windows()", "w.tabs()", "t.sessions()"]) {
    assert.ok(JXA_WALK_PRELUDE.includes(level), level);
  }
  assert.match(JXA_WALK_PRELUDE, /try \{ var l = f\(\); return l \? l : \[\]; \} catch/);
  assert.match(JXA_WALK_PRELUDE, /if \(!w\) return;/);
  assert.match(JXA_WALK_PRELUDE, /if \(!t\) return;/);
  assert.match(JXA_WALK_PRELUDE, /if \(!s\) return;/);
  assert.match(JXA_WALK_PRELUDE, /try \{ fn\(s\); \} catch/);
  assert.ok(buildItermJxa(1, "return '';").includes("function eachSession"));
});

test("withSessionJxa guards every level", () => {
  const js = withSessionJxa("x", "return 'ok';");
  assert.match(js, /safeList\(function \(\) \{ return app\.windows\(\)/);
  assert.match(js, /safeList\(function \(\) \{ return aWindow\.tabs\(\)/);
  assert.match(js, /safeList\(function \(\) \{ return aTab\.sessions\(\)/);
  assert.match(js, /if \(!aSession\) continue;/);
});

test("no source walks windows/tabs/sessions unguarded", () => {
  for (const f of [
    "src/adapters/iterm/core.ts",
    "src/adapters/iterm/sessions.ts",
    "src/daemon/sessions.ts",
    "src/mcp/index.ts",
  ]) {
    assert.doesNotMatch(readFileSync(f, "utf8"), /w\.tabs\(\)\.forEach/, f);
  }
});

test("the guarded walk survives null tabs, a throwing window and a null session (executed)", () => {
  const body = `  var out = "";
  eachSession(function (s) { out += s.id() + ";"; });
  return out;`;
  const app = {
    windows: () => [
      { tabs: () => null },
      null,
      { tabs: () => { throw new TypeError("closing"); } },
      { tabs: () => [null, { sessions: () => null }, { sessions: () => [null, { id: () => { throw new Error("gone"); } }, { id: () => "A" }] }] },
    ],
  };
  const src = `${JXA_WALK_PRELUDE}\n${body}`;
  assert.equal(new Function("app", src)(app), "A;");
});

test("withEnumRetry retries once after a failure, with a pause", () => {
  let calls = 0;
  const sleeps: number[] = [];
  const out = withEnumRetry(() => (++calls === 1 ? null : "ok"), (ms) => sleeps.push(ms));
  assert.equal(out, "ok");
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [300]);
});

test("withEnumRetry does not retry a success and gives up after one retry", () => {
  let calls = 0;
  assert.equal(withEnumRetry(() => (calls++, "x"), () => assert.fail("slept")), "x");
  assert.equal(calls, 1);
  calls = 0;
  assert.equal(withEnumRetry(() => (calls++, null), () => {}), null);
  assert.equal(calls, 2);
});
