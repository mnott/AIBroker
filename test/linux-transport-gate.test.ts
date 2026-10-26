import "./home-guard.js";
/**
 * test/linux-transport-gate.test.ts — which terminal hosts are in play is one
 * decision (transport/policy.ts). Platform and env are injected, never read
 * from the host, so the gate is proven identically on macOS and Linux CI.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { transportPolicy, itermInPlay } = await import("../src/transport/policy.js");
const { localPlayerCommand } = await import("../src/core/bins.js");
const core = await import("../src/adapters/iterm/core.js");

test("non-darwin defaults to tmux only", () => {
  for (const platform of ["linux", "freebsd", "win32"] as const) {
    assert.deepEqual(transportPolicy({}, platform), { allowIterm: false, allowTmux: true });
    assert.equal(itermInPlay({}, platform), false);
  }
});

test("darwin with no override keeps iTerm and tmux both in play", () => {
  assert.deepEqual(transportPolicy({}, "darwin"), { allowIterm: true, allowTmux: true });
});

test("AIBROKER_TRANSPORT overrides the platform default, case-insensitively", () => {
  assert.deepEqual(transportPolicy({ AIBROKER_TRANSPORT: "tmux" }, "darwin"), { allowIterm: false, allowTmux: true });
  assert.deepEqual(transportPolicy({ AIBROKER_TRANSPORT: " TMUX " }, "darwin"), { allowIterm: false, allowTmux: true });
  assert.deepEqual(transportPolicy({ AIBROKER_TRANSPORT: "iterm" }, "linux"), { allowIterm: true, allowTmux: false });
  // Unknown value = no override.
  assert.deepEqual(transportPolicy({ AIBROKER_TRANSPORT: "multi" }, "linux"), { allowIterm: false, allowTmux: true });
  assert.deepEqual(transportPolicy({ AIBROKER_TRANSPORT: "multi" }, "darwin"), { allowIterm: true, allowTmux: true });
});

test("with tmux forced, iTerm enumeration never runs osascript and is reliable, not degraded", () => {
  const prev = process.env.AIBROKER_TRANSPORT;
  process.env.AIBROKER_TRANSPORT = "tmux";
  const original = core._internal.runItermJxa;
  let calls = 0;
  core._internal.runItermJxa = () => { calls++; return null; };
  try {
    core.invalidateSnapshotCache();
    assert.deepEqual(core.snapshotAllSessions({ fresh: true }), []);
    assert.equal(core.wasLastSnapshotReliable(), true);
    assert.equal(core.isItermRunning(), false);
    assert.deepEqual(core.findItermBundleIdImpostors(), []);
    assert.equal(calls, 0);
  } finally {
    core._internal.runItermJxa = original;
    if (prev === undefined) delete process.env.AIBROKER_TRANSPORT; else process.env.AIBROKER_TRANSPORT = prev;
    core.invalidateSnapshotCache();
  }
});

test("runAppleScript never spawns osascript off macOS", () => {
  const real = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "linux" });
  try {
    assert.equal(core.runAppleScript('tell application "iTerm2" to count windows'), null);
    assert.equal(core.isScreenLocked(), false);
  } finally {
    Object.defineProperty(process, "platform", real);
  }
});

test("local player: afplay on macOS, an override-resolved paplay elsewhere", () => {
  assert.deepEqual(localPlayerCommand("darwin"), ["afplay"]);
  const dir = mkdtempSync(join(tmpdir(), "aibroker-player-"));
  const fake = join(dir, "paplay");
  writeFileSync(fake, "#!/bin/sh\n");
  process.env.AIBROKER_PAPLAY_BIN = fake;
  try {
    assert.deepEqual(localPlayerCommand("linux"), [fake]);
  } finally {
    delete process.env.AIBROKER_PAPLAY_BIN;
  }
});
