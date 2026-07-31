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
