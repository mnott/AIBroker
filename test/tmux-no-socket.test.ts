/**
 * test/tmux-no-socket.test.ts — runTmux must not spawn when no tmux server
 * is reachable.
 *
 * A machine with no tmux server has no socket file either, so every call
 * used to spawnSync anyway and fail with "error connecting to ... (No such
 * file or directory)" — spammed to the daemon log on every session
 * enumeration and every id routing. Checking for the socket file first turns
 * that into a stat, no spawn, no log line.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import cp from "node:child_process";
import { TmuxTransport } from "../src/transport/tmux.js";

test("listSessions/paneFor return empty with no spawn when the tmux socket is absent", () => {
  const originalTmuxTmpdir = process.env.TMUX_TMPDIR;
  const originalTmux = process.env.TMUX;
  process.env.TMUX_TMPDIR = "/tmp/aibroker-test-no-such-tmux-dir";
  delete process.env.TMUX;

  const originalSpawnSync = cp.spawnSync;
  let spawnCount = 0;
  cp.spawnSync = ((...args: Parameters<typeof cp.spawnSync>) => {
    spawnCount++;
    return originalSpawnSync(...args);
  }) as typeof cp.spawnSync;

  try {
    const transport = new TmuxTransport();
    assert.deepEqual(transport.listSessions(), []);
    assert.equal(transport.paneFor("@some-durable-id"), null);
    assert.equal(transport.isAvailable(), false);
    assert.equal(spawnCount, 0, "no process should have been spawned");
  } finally {
    cp.spawnSync = originalSpawnSync;
    if (originalTmuxTmpdir === undefined) delete process.env.TMUX_TMPDIR;
    else process.env.TMUX_TMPDIR = originalTmuxTmpdir;
    if (originalTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = originalTmux;
  }
});
