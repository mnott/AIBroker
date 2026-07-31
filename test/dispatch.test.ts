/**
 * test/dispatch.test.ts — the task-bus transport contract.
 *
 * PAI parses {outcome, project, session, reason} and routes on `outcome`, so the
 * outcome matrix IS the interface. These drive dispatch() with injected deps —
 * no iTerm, no daemon, no `pai` binary.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dispatch,
  findSessionForProject,
  TASK_PREFIX,
  type DispatchDeps,
} from "../src/daemon/dispatch.js";
import type { PaiProject } from "../src/daemon/pai-projects.js";

const project = (over: Partial<PaiProject> = {}): PaiProject => ({
  name: "whazaa",
  names: ["whazaa"],
  slug: "whazaa",
  displayName: "Whazaa",
  rootPath: "/dev/ai/Whazaa",
  sessionCount: 0,
  lastActive: "",
  ...over,
});

/** Deps that fail loudly: each test opts into exactly the behaviour it needs. */
function deps(over: Partial<DispatchDeps> = {}): DispatchDeps {
  return {
    resolve: async () => project(),
    sessions: () => [],
    deliver: async () => "ok",
    launch: async () => { throw new Error("launch should not have been called"); },
    waitReady: async () => true,
    now: () => 0,
    ...over,
  };
}

const live = (label: string, id = "S1") => [{ id, name: label, paiName: label }];

// ── outcome matrix ──────────────────────────────────────────────────────────

test("a live session gets the work order -> delivered", async () => {
  const sent: string[] = [];
  const r = await dispatch("whazaa", "do the thing", {}, deps({
    sessions: () => live("Whazaa"),
    deliver: async (_id, body) => { sent.push(body); return "ok"; },
  }));
  assert.equal(r.outcome, "delivered");
  assert.equal(r.session, "Whazaa");
  assert.equal(sent.length, 1);
});

test("no live session -> launch, wait, deliver -> spawned", async () => {
  let launched: string | null = null;
  const r = await dispatch("whazaa", "do the thing", {}, deps({
    sessions: () => [],
    launch: async (p) => { launched = p.rootPath; return { itermSessionId: "NEW" }; },
    waitReady: async () => true,
  }));
  assert.equal(r.outcome, "spawned");
  assert.equal(launched, "/dev/ai/Whazaa");
});

test("no curated alias -> unlaunchable, and nothing is launched", async () => {
  const r = await dispatch("mystery", "x", {}, deps({ resolve: async () => undefined }));
  assert.equal(r.outcome, "unlaunchable");
  assert.equal(r.project, "mystery", "echoes back what was asked for");
  assert.match(r.reason, /pai project name/, "reason must say how to fix it");
});

test("--no-spawn with no live session -> skipped", async () => {
  const r = await dispatch("whazaa", "x", { noSpawn: true }, deps({ sessions: () => [] }));
  assert.equal(r.outcome, "skipped");
});

test("--no-spawn still delivers when a session IS live", async () => {
  const r = await dispatch("whazaa", "x", { noSpawn: true }, deps({
    sessions: () => live("Whazaa"),
  }));
  assert.equal(r.outcome, "delivered");
});

test("spawned tab that never comes up -> unreachable, NOT spawned", async () => {
  const r = await dispatch("whazaa", "x", {}, deps({
    launch: async () => ({ itermSessionId: "NEW" }),
    waitReady: async () => false,
    deliver: async () => { throw new Error("must not deliver to a session that never came up"); },
  }));
  assert.equal(r.outcome, "unreachable");
  assert.match(r.reason, /did not become ready/);
});

test("spawned tab that comes up but never accepts the message -> unreachable", async () => {
  // The failure that would otherwise be a green `spawned` with nothing delivered.
  const r = await dispatch("whazaa", "x", {}, deps({
    launch: async () => ({ itermSessionId: "NEW" }),
    waitReady: async () => true,
    deliver: async () => "no-ack",
  }));
  assert.equal(r.outcome, "unreachable");
  assert.match(r.reason, /never reacted/);
});

test("a live session that never accepts the message -> unreachable", async () => {
  const r = await dispatch("whazaa", "x", {}, deps({
    sessions: () => live("Whazaa"),
    deliver: async () => "no-ack",
  }));
  assert.equal(r.outcome, "unreachable");
  assert.equal(r.session, "Whazaa");
});

test("a launch that throws is reported, not propagated", async () => {
  const r = await dispatch("whazaa", "x", {}, deps({
    launch: async () => { throw new Error("iTerm refused"); },
  }));
  assert.equal(r.outcome, "unreachable");
  assert.match(r.reason, /iTerm refused/);
});

// ── message shaping ─────────────────────────────────────────────────────────

test("the body is prefixed with [Task], not [Session:...]", async () => {
  // [Session:X] means "reply to X"; the sender of a task has already exited, so
  // promising a reply path that does not exist is worse than promising none.
  let body = "";
  await dispatch("whazaa", "line one\nline two", {}, deps({
    sessions: () => live("Whazaa"),
    deliver: async (_id, b) => { body = b; return "ok"; },
  }));
  assert.ok(body.startsWith(TASK_PREFIX), `expected ${TASK_PREFIX} prefix, got: ${body.slice(0, 40)}`);
  assert.ok(!body.includes("[Session:"), "must not claim a reply channel");
  assert.ok(body.includes("line one\nline two"), "body must survive verbatim");
});

test("multi-line bodies with quotes and backticks survive intact", async () => {
  const nasty = 'run `npm test` and check "the output"\n\n- a\n- b\n$(not-a-substitution)';
  let body = "";
  await dispatch("whazaa", nasty, {}, deps({
    sessions: () => live("Whazaa"),
    deliver: async (_id, b) => { body = b; return "ok"; },
  }));
  assert.ok(body.endsWith(nasty), "the body must not be mangled or escaped");
});

// ── the shared budget ───────────────────────────────────────────────────────
//
// The caller wraps this process in its own kill timer. If our stages each held
// an independent limit they would sum past the caller's budget, it would kill
// us before our deadline fired, and its timeout would mask our reason — a
// failure that cannot be reproduced from this side. --timeout is therefore ONE
// budget shared by every stage.

/** Deps with a controllable clock; `spend` advances it inside a stage. */
function timed(over: Partial<DispatchDeps> = {}) {
  let clock = 0;
  const d = deps({
    now: () => clock,
    ...over,
  });
  return { deps: d, spend: (ms: number) => { clock += ms; }, elapsed: () => clock };
}

test("spawn wait and delivery share the budget, never sum past it", async () => {
  let readyGot = 0;
  let deliverGot = 0;
  const t = timed();
  t.deps.sessions = () => [];
  t.deps.launch = async () => ({ itermSessionId: "NEW" });
  // Readiness returns as soon as the input box appears — here after 10s of its
  // 60s allowance — so the rest of the budget must carry over to delivery.
  t.deps.waitReady = async (_id, ms) => { readyGot = ms; t.spend(10_000); return true; };
  t.deps.deliver = async (_id, _b, ms) => { deliverGot = ms; return "ok"; };

  const r = await dispatch("whazaa", "x", { budgetMs: 60_000 }, t.deps);

  assert.equal(r.outcome, "spawned");
  assert.ok(readyGot <= 60_000, `readiness got ${readyGot}ms of a 60s budget`);
  assert.equal(deliverGot, 50_000, "delivery gets what booting did not use");
  assert.ok(
    t.elapsed() + deliverGot <= 60_000,
    `worst case ${t.elapsed() + deliverGot}ms exceeds the 60s budget`,
  );
});

test("a slow boot leaves delivery a smaller slice, not a fresh one", async () => {
  let deliverGot = 0;
  const t = timed();
  t.deps.sessions = () => [];
  t.deps.launch = async () => ({ itermSessionId: "NEW" });
  t.deps.waitReady = async () => { t.spend(50_000); return true; }; // boot ate 50 of 60
  t.deps.deliver = async (_id, _b, ms) => { deliverGot = ms; return "ok"; };

  await dispatch("whazaa", "x", { budgetMs: 60_000 }, t.deps);
  assert.equal(deliverGot, 10_000, "delivery should get only the remaining 10s");
});

test("a boot that eats the whole budget is reported, not blamed on the session", async () => {
  const t = timed();
  t.deps.sessions = () => [];
  t.deps.launch = async () => ({ itermSessionId: "NEW" });
  t.deps.waitReady = async () => { t.spend(60_000); return true; };
  t.deps.deliver = async () => { throw new Error("must not deliver with no budget left"); };

  const r = await dispatch("whazaa", "x", { budgetMs: 60_000 }, t.deps);
  assert.equal(r.outcome, "unreachable");
  assert.match(r.reason, /budget was spent/);
});

test("the caller's budget overrides a larger per-stage default", async () => {
  // Default spawn wait is 90s; a 30s budget must win, or we outlive the caller.
  let readyGot = 0;
  const t = timed();
  t.deps.sessions = () => [];
  t.deps.launch = async () => ({ itermSessionId: "NEW" });
  t.deps.waitReady = async (_id, ms) => { readyGot = ms; return true; };

  await dispatch("whazaa", "x", { budgetMs: 30_000 }, t.deps);
  assert.equal(readyGot, 30_000);
});

test("no budget means the per-stage defaults apply unchanged", async () => {
  let readyGot = 0;
  const t = timed();
  t.deps.sessions = () => [];
  t.deps.launch = async () => ({ itermSessionId: "NEW" });
  t.deps.waitReady = async (_id, ms) => { readyGot = ms; return true; };

  await dispatch("whazaa", "x", {}, t.deps);
  assert.equal(readyGot, 90_000, "unbudgeted callers keep the old behaviour");
});

test("delivery to an already-live session respects the budget too", async () => {
  let deliverGot = 0;
  const t = timed();
  t.deps.sessions = () => live("Whazaa");
  t.deps.deliver = async (_id, _b, ms) => { deliverGot = ms; return "ok"; };

  await dispatch("whazaa", "x", { budgetMs: 20_000 }, t.deps);
  assert.equal(deliverGot, 20_000);
});

// ── session matching (PAI's bite #1) ────────────────────────────────────────

test("session matching is case-insensitive", () => {
  const p = project({ displayName: "Whazaa", names: ["whazaa"] });
  for (const label of ["whazaa", "WHAZAA", "Whazaa", "WhAzAa"]) {
    assert.ok(findSessionForProject(p, live(label)), `should match "${label}"`);
  }
});

test("any curated alias matches, not just the display name", () => {
  const p = project({ displayName: "BirnPartners", names: ["birnpartners", "birn"] });
  assert.ok(findSessionForProject(p, live("birn")));
  assert.ok(findSessionForProject(p, live("BirnPartners")));
});

test("an unrelated session is not matched", () => {
  const p = project({ displayName: "Whazaa", names: ["whazaa"] });
  assert.equal(findSessionForProject(p, live("Telex")), null);
});

test("a substring is not a match", () => {
  // "Jobs Matthias 2" must not satisfy a dispatch aimed at "Jobs Matthias".
  const p = project({ displayName: "Jobs Matthias", names: ["jobs-matthias"] });
  assert.equal(findSessionForProject(p, live("Jobs Matthias 2")), null);
});

test("the persistent PAI name wins over the raw session name", () => {
  const p = project({ displayName: "Whazaa", names: ["whazaa"] });
  const sessions = [{ id: "S1", name: "node", paiName: "Whazaa" }];
  assert.equal(findSessionForProject(p, sessions)?.id, "S1");
});
