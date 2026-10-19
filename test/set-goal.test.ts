import "./home-guard.js";
/**
 * test/set-goal.test.ts — aibroker_set_goal, the one-call "set your goal".
 *
 * The tool is the operator's own phrase ("set your goal", "arm", "keep working
 * until 8pm") turned into a tool that does the whole flow in one call. It owns
 * none of the supervision logic itself: it delegates to the very same hub
 * `manage` path that aibroker_manage action=supervise takes, with session=self,
 * and pins exactly what it sends and what it says afterwards.
 *
 * The hub call is injected, so nothing here touches a daemon.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// importing src/mcp/index.ts resolves session identity at load; give it an
// answer up front so the test never walks the process tree or asks iTerm.
process.env.ITERM_SESSION_ID = "w0t0p0:SET-GOAL-TEST";

const { setGoal } = await import("../src/mcp/index.js");

type Call = { method: string; params: Record<string, unknown> };

function recordingCall(answer: unknown = { message: "alpha is supervised until 08:00.\n  alpha | goal: hold the line" }) {
  const calls: Call[] = [];
  const call = async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    return answer;
  };
  return { calls, call };
}

const text = (r: { content: Array<{ text: string }>; isError?: boolean }) => r.content[0].text;
const ARMED = "goal set and armed — marker lands within one tick";

// ── delegation ───────────────────────────────────────────────────────────────

test("goal + until goes to the supervise path with session=self and comes back verbatim, plus the armed line", async () => {
  const { calls, call } = recordingCall();
  const r = await setGoal({ goal: "keep the tests green", until: "08:00" }, call);
  assert.deepEqual(calls, [{
    method: "manage",
    params: { session: "self", arg: "supervise", goal: "keep the tests green", until: "08:00" },
  }]);
  assert.equal(r.isError, undefined);
  assert.ok(text(r).startsWith("alpha is supervised until 08:00.\n  alpha | goal: hold the line"), "supervise result verbatim");
  assert.ok(text(r).endsWith(ARMED), "one armed line after it");
});

test("until omitted defaults to 8h", async () => {
  const { calls, call } = recordingCall();
  await setGoal({ goal: "hold the line" }, call);
  assert.equal(calls[0].params.until, "8h");
});

test("every omitted is not sent at all — supervise keeps the watcher's cadence; given, it passes through", async () => {
  const { calls, call } = recordingCall();
  await setGoal({ goal: "hold the line" }, call);
  assert.equal("every" in calls[0].params, false);

  const second = recordingCall();
  await setGoal({ goal: "hold the line", every: 30 }, second.call);
  assert.equal(second.calls[0].params.every, 30);
  assert.equal("every" in second.calls[0].params, true);
});

// ── validation ───────────────────────────────────────────────────────────────

test("a missing or empty goal is a validation error, and nothing is sent", async () => {
  for (const goal of [undefined, "", "   "]) {
    const { calls, call } = recordingCall();
    const r = await setGoal({ goal, until: "08:00" } as { goal?: string }, call);
    assert.equal(r.isError, true, `goal=${JSON.stringify(goal)}`);
    assert.match(text(r), /goal/i);
    assert.deepEqual(calls, []);
  }
});

test("a hub failure is an error and never claims the goal was armed", async () => {
  const calls: Call[] = [];
  const r = await setGoal({ goal: "hold the line" }, async (method, params) => {
    calls.push({ method, params });
    throw new Error("hub not running");
  });
  assert.equal(r.isError, true);
  assert.match(text(r), /hub not running/);
  assert.ok(!text(r).includes(ARMED));
});

// ── registration ─────────────────────────────────────────────────────────────

test("the tool is registered next to aibroker_manage, speaking the operator's phrase, and aibroker_manage is unchanged", () => {
  const src = readFileSync("src/mcp/index.ts", "utf8");
  const manage = src.indexOf('server.tool(\n  "aibroker_manage"');
  const goal = src.indexOf('server.tool(\n  "aibroker_set_goal"');
  assert.ok(manage > -1, "aibroker_manage registration found");
  assert.ok(goal > manage, "aibroker_set_goal registered after aibroker_manage, beside it");
  const between = src.slice(manage, src.indexOf('server.tool(\n  "aibroker_switch"'));
  assert.ok(between.includes('"aibroker_set_goal"'), "registered directly next to aibroker_manage — nothing else between them");
  assert.ok(src.includes("Never ask the operator to type /goal or arm anything"), "the description carries the instruction not to delegate back to the operator");
  assert.ok(src.includes("Verify afterwards with aibroker_manage action=status"), "the description says how to verify");
  assert.match(src.slice(goal), /setGoal\(a\)/, "the registration delegates to the exported handler");
});
