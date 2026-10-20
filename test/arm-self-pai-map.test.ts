import "./home-guard.js";
/**
 * test/arm-self-pai-map.test.ts — arm-self from a session the env cannot name.
 *
 * `aibroker arm-self` refused every session run under the Claude background
 * daemon (no ITERM_SESSION_ID — observed live 2026-10-20 03:05), and the
 * daemon-run sessions are exactly the overnight supervised ones that most
 * need self-arming. The fix resolves the caller through PAI's session map
 * (daemon/pai-session-map.ts); these tests run the command the way a session
 * does — as a fresh process, against a sandboxed home — and pin both the new
 * resolutions and the refusals that must survive unchanged.
 *
 * The map-liveness cases that need the hub's session list are covered in
 * pai-session-map.test.ts with the list injected; a spawned test has no hub
 * to ask, and a fake daemon socket could collide with the operator's real
 * one, so here the fallback's daemon-down behaviour is pinned as a refusal.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(projectRoot, "src", "daemon", "cli.ts");

const SID = "066504E1-BB16-48D3-9A74-C1F8BA45B7F3";
const OTHER_SID = "AD45835E-7F1E-40B6-B590-9C466F7A9B25";
const CLAUDE_ID = "f56482bd-fbb6-435e-849a-e33b94bd6835";
const NOW = Date.now();

/** A stored watcher. The dead tty keeps saveState's repo mirror off real panes. */
const entry = (over: Record<string, unknown> = {}) => ({
  sessionId: SID,
  name: "ArmSelfMap",
  objective: "keep the inbound queue drained",
  pending: [],
  history: [],
  lastRearmAt: NOW - 600_000,
  lastChangeAt: NOW - 60_000,
  lastHash: "",
  paused: false,
  startedAt: NOW - 3_600_000,
  tty: "/dev/aibroker-arm-self-map-test",
  ...over,
});

const shift = (until: number) => ({ until, workers: 1, visual: false, startedAt: NOW - 3_600_000 });

interface Sandbox {
  home: string;
  managers: string;
  map: string;
}

/**
 * A home whose entire identity state is given here: the watchers in
 * managers.json and the PAI session map. No ITERM_SESSION_ID exists anywhere
 * in the spawned env — that is the daemon-run case under repair.
 */
function sandbox(
  watchers: Record<string, unknown>,
  map: Record<string, unknown> | string | undefined,
): Sandbox {
  const home = mkdtempSync(join(tmpdir(), "aibroker-arm-self-map-"));
  mkdirSync(join(home, ".aibroker"), { recursive: true });
  writeFileSync(join(home, ".aibroker", "managers.json"), JSON.stringify(watchers));
  const mapPath = join(home, ".claude", "pai", "session-claude-map.json");
  if (map !== undefined) {
    mkdirSync(dirname(mapPath), { recursive: true });
    writeFileSync(mapPath, typeof map === "string" ? map : JSON.stringify(map));
  }
  return { home, managers: join(home, ".aibroker", "managers.json"), map: mapPath };
}

function runArmSelf(s: Sandbox, envOverrides: Record<string, string | undefined> = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // The caller this command models has none of these; the parent test process
  // must not lend it one. Overrides are applied AFTER the strip — an override
  // that the strip then deleted made this suite fail its first run.
  delete env.ITERM_SESSION_ID;
  delete env.TERM_SESSION_ID;
  delete env.TMUX_PANE;
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CLAUDE_SESSION_ID;
  delete env.PAI_WORKER;
  Object.assign(env, envOverrides);
  env.HOME = s.home;
  env.USERPROFILE = s.home;
  return spawnSync("npx", ["tsx", CLI, "arm-self"], { env, encoding: "utf-8", timeout: 60_000 });
}

const readBack = (s: Sandbox) =>
  JSON.parse(readFileSync(s.managers, "utf8")) as Record<string, any>;

const readMap = (s: Sandbox) =>
  JSON.parse(readFileSync(s.map, "utf8")) as Record<string, { uid: string; ts: number }>;

test("daemon-run session, claude env id + map hit: arms, and refreshes the ts it used", () => {
  const s = sandbox(
    { [SID]: entry({ shift: shift(NOW + 3_600_000) }) },
    { [CLAUDE_ID]: { uid: SID, ts: NOW - 600_000 } },
  );
  const r = runArmSelf(s, { CLAUDE_CODE_SESSION_ID: CLAUDE_ID });
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  assert.match(r.stdout + r.stderr, /arming on the next tick/);
  assert.equal(readBack(s)[SID].lastRearmAt, 0, "the every-ask-is-now sentinel must be set");
  const saved = readMap(s);
  assert.ok(
    saved[CLAUDE_ID].ts > NOW - 600_000,
    "the entry that answered is refreshed for the next reader",
  );
});

test("no env id, single fresh entry, hub cannot confirm it live: refused", () => {
  // The spawned CLI has no daemon session list to ask (and must not invent
  // one), so an unconfirmable candidate stays a refusal — pinned here so the
  // fallback can never quietly become a guess.
  const s = sandbox(
    { [SID]: entry({ shift: shift(NOW + 3_600_000) }) },
    { [CLAUDE_ID]: { uid: SID, ts: NOW - 60_000 } },
  );
  const r = runArmSelf(s);
  assert.equal(r.status, 1, `exit ${r.status}: ${r.stdout}`);
  assert.match(r.stdout + r.stderr, /inside your own session/);
  assert.equal(readBack(s)[SID].lastRearmAt, NOW - 600_000, "nothing is armed on a guess");
});

test("env id present but absent from the map: refused, not traded for the newest entry", () => {
  const s = sandbox(
    { [SID]: entry({ shift: shift(NOW + 3_600_000) }) },
    { ["another-claude-session-id"]: { uid: SID, ts: NOW - 60_000 } },
  );
  const r = runArmSelf(s, { CLAUDE_CODE_SESSION_ID: CLAUDE_ID });
  assert.equal(r.status, 1, `exit ${r.status}: ${r.stdout}`);
  assert.match(r.stdout + r.stderr, /inside your own session/);
  assert.equal(readBack(s)[SID].lastRearmAt, NOW - 600_000);
});

test("map missing: refused with today's message", () => {
  const s = sandbox({ [SID]: entry({ shift: shift(NOW + 3_600_000) }) }, undefined);
  const r = runArmSelf(s, { CLAUDE_CODE_SESSION_ID: CLAUDE_ID });
  assert.equal(r.status, 1, `exit ${r.status}: ${r.stdout}`);
  assert.match(r.stdout + r.stderr, /run this from inside your own session — it arms the session that types it\./);
});

test("map malformed: refused with today's message", () => {
  const s = sandbox({ [SID]: entry({ shift: shift(NOW + 3_600_000) }) }, "not json at all{{{");
  const r = runArmSelf(s, { CLAUDE_CODE_SESSION_ID: CLAUDE_ID });
  assert.equal(r.status, 1, `exit ${r.status}: ${r.stdout}`);
  assert.match(r.stdout + r.stderr, /run this from inside your own session — it arms the session that types it\./);
  assert.equal(readBack(s)[SID].lastRearmAt, NOW - 600_000);
});

test("no env id, two fresh entries: refused either way", () => {
  // Ambiguous even before liveness is asked; the resolver refuses both ways.
  const s = sandbox(
    { [SID]: entry({ shift: shift(NOW + 3_600_000) }) },
    {
      [CLAUDE_ID]: { uid: SID, ts: NOW - 60_000 },
      ["another-claude-session-id"]: { uid: OTHER_SID, ts: NOW - 120_000 },
    },
  );
  const r = runArmSelf(s);
  assert.equal(r.status, 1, `exit ${r.status}: ${r.stdout}`);
  assert.match(r.stdout + r.stderr, /inside your own session/);
});

test("the map path changes nothing for a caller the env does name", () => {
  // Regression guard: with ITERM_SESSION_ID set, resolution is the old one and
  // the map is not consulted even when it is garbage.
  const s = sandbox({ [SID]: entry({ shift: shift(NOW + 3_600_000) }) }, "not json at all{{{");
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CLAUDE_SESSION_ID;
  delete env.PAI_WORKER;
  env.HOME = s.home;
  env.USERPROFILE = s.home;
  env.ITERM_SESSION_ID = `w0t0p0:${SID}`;
  const r = spawnSync("npx", ["tsx", CLI, "arm-self"], { env, encoding: "utf-8", timeout: 60_000 });
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  assert.match(r.stdout + r.stderr, /arming on the next tick/);
});
