import "./home-guard.js";
/**
 * test/launch-cli.test.ts — `aibroker launch` argument resolution and the
 * attach-if-running check. Transport, daemon and filesystem are injected.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { findRunning, launch, parseLaunchArgs, resolveLaunchTarget, type LaunchDeps, type LiveRow } from "../src/daemon/launch-cli.js";
import type { LaunchOptions, SessionTransport } from "../src/transport/index.js";

const base = { cwd: "/w", home: "/h" };
const dirs = new Set(["/w/proj", "/h/src/app", "/abs/x"]);
const isDir = (p: string) => dirs.has(p);

test("parseLaunchArgs takes --name in either position", () => {
  assert.deepEqual(parseLaunchArgs(["--name", "n", "d"]), { target: "d", name: "n" });
  assert.deepEqual(parseLaunchArgs(["d", "--name=n"]), { target: "d", name: "n" });
});

test("path-like arguments are directories; name defaults to the basename", () => {
  const t = resolveLaunchTarget("~/src/app", undefined, { ...base, isDir, paiPresent: () => true });
  assert.deepEqual(t, { kind: "dir", dir: "/h/src/app", name: "app" });
  assert.deepEqual(resolveLaunchTarget("./proj", "web", { ...base, isDir, paiPresent: () => true }), { kind: "dir", dir: "/w/proj", name: "web" });
});

test("a bare word is a PAI project when PAI exists, even if a directory of that name is here", () => {
  assert.deepEqual(resolveLaunchTarget("proj", undefined, { ...base, isDir, paiPresent: () => true }), { kind: "pai", name: "proj" });
});

test("a bare word is a directory when PAI is absent", () => {
  assert.deepEqual(resolveLaunchTarget("proj", undefined, { ...base, isDir, paiPresent: () => false }), { kind: "dir", dir: "/w/proj", name: "proj" });
});

test("a missing directory is an error that names the argument", () => {
  assert.throws(() => resolveLaunchTarget("/nope", undefined, { ...base, isDir, paiPresent: () => false }), /"\/nope" is not a directory/);
  assert.throws(() => resolveLaunchTarget("ghost", undefined, { ...base, isDir, paiPresent: () => false }), /PAI is not installed/);
});

test("findRunning: paiName, or a live Claude by name/dir — never a shell", () => {
  const rows: LiveRow[] = [
    { sessionId: "a", paiName: "Solar", kind: "claude" },
    { sessionId: "b", name: "api", kind: "shell", cwd: "/w/api" },
    { sessionId: "c", name: "web", kind: "claude", cwd: "/w/web" },
  ];
  assert.equal(findRunning(rows, "solar")?.sessionId, "a");
  assert.equal(findRunning(rows, "api", "/w/api"), undefined, "a shell in the same directory is not a session");
  assert.equal(findRunning(rows, "web")?.sessionId, "c");
  assert.equal(findRunning(rows, "other", "/w/web")?.sessionId, "c", "same directory, other name: still attached");
});

function deps(over: Partial<LaunchDeps> & { launched?: LaunchOptions[]; rows?: LiveRow[] } = {}): LaunchDeps & { lines: string[] } {
  const lines: string[] = [];
  const transport = {
    launch: (o: LaunchOptions) => { over.launched?.push(o); return { id: "uuid-1", transport: "tmux", where: 'window "proj" in tmux session "aibroker"', attach: "tmux attach -t aibroker" }; },
  } as unknown as SessionTransport;
  return {
    transport: () => transport,
    sessions: async () => over.rows ?? [],
    paiLaunch: async () => ({ itermSessionId: "GUID", name: "P" }),
    isDir,
    paiPresent: () => false,
    ...base,
    out: (l) => lines.push(l),
    ...over,
    lines,
  } as LaunchDeps & { lines: string[] };
}

test("launching a directory goes through the transport and prints transport + id + attach", async () => {
  const launched: LaunchOptions[] = [];
  const d = deps({ launched });
  assert.equal(await launch(["/abs/x", "--name", "ex"], d), 0);
  assert.deepEqual(launched, [{ dir: "/abs/x", name: "ex" }]);
  assert.match(d.lines.join("\n"), /tmux uuid-1/);
  assert.match(d.lines.join("\n"), /attach: tmux attach -t aibroker/);
});

test("an already-running session is attached, not launched twice", async () => {
  const launched: LaunchOptions[] = [];
  const d = deps({ launched, rows: [{ sessionId: "S9", name: "x", kind: "claude", cwd: "/abs/x", transport: "tmux" }] });
  assert.equal(await launch(["/abs/x"], d), 0);
  assert.equal(launched.length, 0);
  assert.match(d.lines.join("\n"), /already running/);
  assert.match(d.lines.join("\n"), /tmux S9/);
});

test("a PAI project keeps going through pai_launch", async () => {
  const launched: LaunchOptions[] = [];
  const d = deps({ launched, paiPresent: () => true });
  assert.equal(await launch(["proj"], d), 0);
  assert.equal(launched.length, 0);
  assert.match(d.lines.join("\n"), /iterm GUID/);
});

test("a refused launch and a missing argument both exit non-zero", async () => {
  const refuse = deps();
  refuse.transport = () => ({ launch: () => null }) as unknown as SessionTransport;
  assert.equal(await launch(["/abs/x"], refuse), 1);
  assert.equal(await launch([], deps()), 1);
});
