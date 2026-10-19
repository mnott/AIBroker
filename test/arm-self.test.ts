import "./home-guard.js";
/**
 * test/arm-self.test.ts — one command, zero arguments, zero judgment.
 *
 * Watched sessions coming out of a compact kept re-deriving how to demand
 * their own arming — objective to /tmp, TODO.md updated, the operator asked to
 * type the /goal line by hand — while the watcher sat in managers.json the
 * whole time. `aibroker arm-self` is the deterministic shortcut, and these
 * tests run it the way a session does: as a fresh process, from inside "its"
 * pane, against a sandboxed managers.json. Every refusal the manager itself
 * would give (no watcher, paused, until passed) must come out of the command,
 * because a session that cannot tell "refused" from "arming" will keep asking.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(projectRoot, "src", "daemon", "cli.ts");

const SID = "066504E1-BB16-48D3-9A74-C1F8BA45B7F3";
const NOW = Date.now();

/** A stored watcher. The dead tty keeps saveState's repo mirror off real panes. */
const entry = (over: Record<string, unknown> = {}) => ({
  sessionId: SID,
  name: "ArmSelf",
  objective: "keep the inbound queue drained",
  pending: [],
  history: [],
  lastRearmAt: NOW - 600_000,
  lastChangeAt: NOW - 60_000,
  lastHash: "",
  paused: false,
  startedAt: NOW - 3_600_000,
  tty: "/dev/aibroker-arm-self-test",
  ...over,
});

const shift = (until: number) => ({ until, workers: 1, visual: false, startedAt: NOW - 3_600_000 });

/** A home whose entire aibroker state is the one managers.json given here. */
function sandboxHome(watchers: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), "aibroker-arm-self-"));
  mkdirSync(join(home, ".aibroker"), { recursive: true });
  writeFileSync(join(home, ".aibroker", "managers.json"), JSON.stringify(watchers));
  return home;
}

function runArmSelf(home: string, itermSessionId?: string) {
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  if (itermSessionId === undefined) delete env.ITERM_SESSION_ID;
  else env.ITERM_SESSION_ID = itermSessionId;
  return spawnSync("npx", ["tsx", CLI, "arm-self"], { env, encoding: "utf-8", timeout: 60_000 });
}

const readBack = (home: string) =>
  JSON.parse(readFileSync(join(home, ".aibroker", "managers.json"), "utf8")) as Record<string, any>;

test("a watched, live session arms itself: sentinel set, exit 0, next tick promised", () => {
  const home = sandboxHome({ [SID]: entry({ shift: shift(NOW + 3_600_000) }) });
  const r = runArmSelf(home, `w0t0p0:${SID}`);
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  assert.match(r.stdout + r.stderr, /arming on the next tick/);
  const saved = readBack(home);
  assert.equal(saved[SID].lastRearmAt, 0, "the every-ask-is-now sentinel must be set, not a fresh timestamp");
});

test("no ITERM_SESSION_ID: refused — it arms the session that types it", () => {
  const home = sandboxHome({ [SID]: entry() });
  const r = runArmSelf(home);
  assert.equal(r.status, 1, `exit ${r.status}: ${r.stdout}`);
  assert.match(r.stdout + r.stderr, /inside your own session/);
  assert.equal(readBack(home)[SID].lastRearmAt, NOW - 600_000, "nothing is armed for a session that cannot be named");
});

test("no watcher entry: refused, with the install recipe", () => {
  const home = sandboxHome({});
  const r = runArmSelf(home, `w0t0p0:${SID}`);
  assert.equal(r.status, 1, `exit ${r.status}: ${r.stdout}`);
  assert.match(r.stdout + r.stderr, /no watcher for this session yet\. Install one: aibroker manage supervise <objective> until <time>/);
});

test("paused: refused — resuming is the operator's", () => {
  const home = sandboxHome({ [SID]: entry({ paused: true }) });
  const r = runArmSelf(home, `w0t0p0:${SID}`);
  assert.equal(r.status, 1, `exit ${r.status}: ${r.stdout}`);
  assert.match(r.stdout + r.stderr, /PAUSED/);
  assert.equal(readBack(home)[SID].lastRearmAt, NOW - 600_000, "a paused watcher must not be armed behind the refusal");
});

test("until passed: refused — the stretch is over, re-supervise", () => {
  const home = sandboxHome({ [SID]: entry({ shift: shift(NOW - 60_000) }) });
  const r = runArmSelf(home, `w0t0p0:${SID}`);
  assert.equal(r.status, 1, `exit ${r.status}: ${r.stdout}`);
  assert.match(r.stdout + r.stderr, /until has passed/);
  assert.equal(readBack(home)[SID].lastRearmAt, NOW - 600_000, "a spent watcher must not be armed behind the refusal");
});

test("only the sentinel moves: objective, until, pause and nudges come back untouched", () => {
  const before = entry({
    shift: shift(NOW + 3_600_000),
    nudgeEveryMin: 5,
    pending: ["one instruction"],
  });
  const home = sandboxHome({ [SID]: before });
  const r = runArmSelf(home, `w0t0p0:${SID}`);
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  const after = readBack(home)[SID];
  assert.equal(after.lastRearmAt, 0);
  assert.equal(after.objective, before.objective, "the objective is the operator's");
  assert.equal(after.paused, false, "pause state is the operator's");
  assert.deepEqual(after.shift, before.shift, "until is the operator's");
  assert.equal(after.nudgeEveryMin, before.nudgeEveryMin, "nudges are the operator's");
  assert.deepEqual(after.pending, before.pending, "queued instructions are not consumed by arming");
  assert.deepEqual(after.history, before.history, "the arm is not yet history — the tick that arms writes that");
});

// ── the wiring ───────────────────────────────────────────────────────────────

test("the command is wired into the CLI, through the daemon's own state pair", () => {
  // Read as source, not behaviour: a spawned check already proves the happy
  // path, this proves it stays reachable and keeps reusing loadState/saveState
  // instead of growing a second reader of managers.json.
  const cli = readFileSync(new URL("../src/daemon/cli.ts", import.meta.url), "utf8");
  assert.match(cli, /case "arm-self":/, "an unreachable subcommand is the fault this file exists to prevent");
  assert.match(cli, /import\("\.\/manage\.js"\)/, "the state file is read with the daemon's loader, not re-parsed here");
});
