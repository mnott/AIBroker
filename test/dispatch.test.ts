/**
 * test/dispatch.test.ts — the task-bus transport contract.
 *
 * PAI parses {outcome, project, session, reason} and routes on `outcome`, so the
 * outcome matrix IS the interface. These drive dispatch() with injected deps —
 * no iTerm, no daemon, no `pai` binary.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
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
    // A healthy Claude prompt by default; tests override to simulate a shell.
    capture: () => `${"─".repeat(60)} P ──\n❯\n${"─".repeat(60)}\n  status`,
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

test("a spawned session is never typed into — the order rides the launch", async () => {
  // Measured 2026-08-04: a freshly launched session holds its `/Name … go`
  // preamble as QUEUED PROMPTS, which are rendered nowhere. From t~6s the input
  // box looks empty and every readiness check passes, while the preamble stays
  // pending until t~14s. Typing the work order into that window interleaved it
  // with the rename and the resume — twice, in front of the user.
  //
  // So the spawn path hands the order over IN the launch and types nothing.
  // There is no window left to lose it in.
  let initialPrompt = "";
  const r = await dispatch("whazaa", "the actual work", {}, deps({
    launch: async (_p, o) => { initialPrompt = o?.initialPrompt ?? ""; return { itermSessionId: "NEW" }; },
    waitReady: async () => true,
    deliver: async () => { throw new Error("spawning must not type into the session"); },
  }));
  assert.equal(r.outcome, "spawned");
  assert.ok(initialPrompt.includes(TASK_PREFIX), "the queued prompt must carry the routing prefix");
  assert.ok(/work-orders\/.*\.md/.test(initialPrompt), `expected a work-order path, got: ${initialPrompt}`);
  assert.ok(!initialPrompt.includes("\n"), "a newline would split it into two queued prompts");
});

test("the staged work order holds the body verbatim", async () => {
  const nasty = 'run `npm test`\n\n- a\n- b';
  let initialPrompt = "";
  await dispatch("whazaa", nasty, {}, deps({
    launch: async (_p, o) => { initialPrompt = o?.initialPrompt ?? ""; return { itermSessionId: "NEW" }; },
    waitReady: async () => true,
    deliver: async () => { throw new Error("spawning must not type into the session"); },
  }));
  const m = initialPrompt.match(/(\/[^\s]*work-orders\/[^\s]+\.md)/);
  assert.ok(m, `no work-order path in: ${initialPrompt}`);
  const staged = readFileSync(m[1], "utf8");
  assert.ok(staged.startsWith(TASK_PREFIX), "the file must carry the prefix");
  assert.ok(staged.includes(nasty), "the body must survive verbatim, newlines and all");
  rmSync(m[1], { force: true });
});

test("a live session that does not react in time -> queued, not unreachable", async () => {
  // Was `unreachable` until 2026-08-01. It reported failure for a message that
  // had arrived, and the caller retried it into three duplicate work orders.
  const r = await dispatch("whazaa", "x", {}, deps({
    sessions: () => live("Whazaa"),
    deliver: async () => "no-ack",
  }));
  assert.equal(r.outcome, "queued");
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

test("readiness gets the budget, and nothing is delivered afterwards", async () => {
  // The budget used to be split between booting and typing. There is no typing
  // stage any more, so the whole allowance belongs to waiting for the session
  // to come up.
  let readyGot = 0;
  const t = timed();
  t.deps.sessions = () => [];
  t.deps.launch = async () => ({ itermSessionId: "NEW" });
  t.deps.waitReady = async (_id, ms) => { readyGot = ms; t.spend(10_000); return true; };
  t.deps.deliver = async () => { throw new Error("spawning must not type into the session"); };

  const r = await dispatch("whazaa", "x", { budgetMs: 60_000 }, t.deps);

  assert.equal(r.outcome, "spawned");
  assert.ok(readyGot <= 60_000, `readiness got ${readyGot}ms of a 60s budget`);
});

test("a slow boot is a slow boot, not a lost task", async () => {
  // Once the tab exists the order is already queued in it, so a boot that ate
  // the budget must NOT report failure: PAI would retry work that is about to
  // run, which is the duplicate-dispatch bug arriving from the other direction.
  const t = timed();
  t.deps.sessions = () => [];
  t.deps.launch = async () => ({ itermSessionId: "NEW" });
  t.deps.waitReady = async () => { t.spend(59_000); return true; };
  t.deps.deliver = async () => { throw new Error("spawning must not type into the session"); };

  const r = await dispatch("whazaa", "x", { budgetMs: 60_000 }, t.deps);
  assert.equal(r.outcome, "spawned");
});

test("even a fully spent budget reports spawned, because the order is already queued", async () => {
  // This asserted `unreachable` while the work order was typed after boot: with
  // no time left to type, nothing had been handed over and failure was honest.
  // The order now rides the launch, so by the time the budget matters the
  // session already has it. Reporting failure would earn a retry and a second
  // session doing the same job.
  const t = timed();
  t.deps.sessions = () => [];
  t.deps.launch = async () => ({ itermSessionId: "NEW" });
  t.deps.waitReady = async () => { t.spend(60_000); return true; };
  t.deps.deliver = async () => { throw new Error("spawning must not type into the session"); };

  const r = await dispatch("whazaa", "x", { budgetMs: 60_000 }, t.deps);
  assert.equal(r.outcome, "spawned");
});

test("an exhausted budget launches NOTHING, rather than a tab it cannot use", async () => {
  // Launching with no time to deliver cannot succeed, and leaves a real session
  // running that nobody asked for — then blames it for not becoming ready.
  const t = timed();
  t.deps.sessions = () => [];
  t.deps.launch = async () => { throw new Error("must not launch with no budget"); };

  const r = await dispatch("whazaa", "x", { budgetMs: 0 }, t.deps);
  assert.equal(r.outcome, "unreachable");
  assert.equal(r.session, "", "no session was created, so none should be named");
  assert.match(r.reason, /none was/);
  assert.doesNotMatch(r.reason, /did not become ready/, "must not blame a session that never existed");
});

test("a budget-clipped readiness failure blames the budget, not the session", async () => {
  // The diagnostic sends people to the right place: a wait cut short by the
  // caller's timeout is not evidence that the tab is broken.
  const t = timed();
  t.deps.sessions = () => [];
  t.deps.launch = async () => ({ itermSessionId: "NEW" });
  t.deps.waitReady = async () => false;

  const r = await dispatch("whazaa", "x", { budgetMs: 5_000 }, t.deps);
  assert.equal(r.outcome, "unreachable");
  assert.match(r.reason, /caller's 5s budget/);
  assert.match(r.reason, /before suspecting the session/);
});

test("an unclipped readiness failure does point at the session", async () => {
  const t = timed();
  t.deps.sessions = () => [];
  t.deps.launch = async () => ({ itermSessionId: "NEW" });
  t.deps.waitReady = async () => false;

  const r = await dispatch("whazaa", "x", {}, t.deps);
  assert.match(r.reason, /check why it did not start/);
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
  // "Task Bus 2" must not satisfy a dispatch aimed at "Task Bus".
  const p = project({ displayName: "Task Bus", names: ["task-bus"] });
  assert.equal(findSessionForProject(p, live("Task Bus 2")), null);
});

test("the persistent PAI name wins over the raw session name", () => {
  const p = project({ displayName: "Whazaa", names: ["whazaa"] });
  const sessions = [{ id: "S1", name: "node", paiName: "Whazaa" }];
  assert.equal(findSessionForProject(p, sessions)?.id, "S1");
});

// ── separators are not significant ──────────────────────────────────────────
//
// A real miss on 2026-08-01: the alias is `task-bus`, the session is named
// `Task Bus`, and they did not match. A miss here does not fail — it
// SPAWNS. A live session holding the whole conversation was passed over and a
// fresh tab opened in the right directory with none of the context, which looks
// like success from every angle except the one that matters.

test("a hyphenated alias matches a human-named session", () => {
  const project = {
    name: "task-bus", names: ["task-bus"],
    slug: "09-voice-notes", displayName: "09 - Voice Notes",
  } as unknown as Parameters<typeof findSessionForProject>[0];

  const found = findSessionForProject(project, [
    { id: "s-1", name: "✳ Task Bus (node)", paiName: "Task Bus" },
  ]);
  assert.equal(found?.id, "s-1");
});

test("underscores and doubled spaces fold the same way", () => {
  const project = {
    name: "task_bus", names: ["task_bus"], slug: "x", displayName: "x",
  } as unknown as Parameters<typeof findSessionForProject>[0];

  assert.equal(findSessionForProject(project, [
    { id: "s-2", name: "t", paiName: "Task  Bus" },
  ])?.id, "s-2");
});

test("folding separators does not make different projects collide", () => {
  const project = {
    name: "voice-notes", names: ["voice-notes"], slug: "x", displayName: "x",
  } as unknown as Parameters<typeof findSessionForProject>[0];

  assert.equal(findSessionForProject(project, [
    { id: "s-3", name: "t", paiName: "Task Bus" },
  ]), null);
});

// ── a busy session is not an unreachable one ────────────────────────────────
//
// Reported live on 2026-08-01 from the Task Bus session: dispatch returned
// unreachable ("never reacted") and the message had in fact arrived THREE
// times. Claude Code queues typed input while a turn runs and does not read it
// until the turn ends, so silence is the ordinary state of a session that is
// working — not evidence of non-delivery. Calling it unreachable made the
// caller count a strike, report the routine as not running, and dispatch again.

test("a live session that is mid-turn reports queued, not unreachable", async () => {
  let attempts = 0;
  const r = await dispatch("whazaa", "run the sweep", {}, deps({
    sessions: () => live("whazaa"),
    deliver: async () => { attempts++; return "no-ack"; },
  }));
  assert.equal(r.outcome, "queued");
  assert.match(r.reason, /do NOT retry/i);
  assert.equal(attempts, 1, "one attempt — a retype duplicates the work order");
});

test("an unreadable terminal is still unreachable", async () => {
  // "I could not look" is a different problem from "it is busy", and collapsing
  // them sends whoever reads the result to the wrong place.
  const r = await dispatch("whazaa", "x", {}, deps({
    sessions: () => live("whazaa"),
    deliver: async () => "unreadable",
  }));
  assert.equal(r.outcome, "unreachable");
});

test("delivery is attempted exactly once against a live session", async () => {
  let attempts = 0;
  await dispatch("whazaa", "x", {}, deps({
    sessions: () => live("whazaa"),
    deliver: async (_id, _b, _t, _io, retries) => { attempts = retries ?? 3; return "ok"; },
  }));
  assert.equal(attempts, 1, "dispatch must ask for a single attempt on a live session");
});
