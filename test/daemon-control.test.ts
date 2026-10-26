import "./home-guard.js";
/**
 * test/daemon-control.test.ts — stop/restart fallback order:
 * active service → IPC shutdown → pidfile. No systemctl, launchctl or daemon.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { restartDaemon, stopDaemon, servicePaths, type ControlDeps } from "../src/daemon/daemon-control.js";

function mk(over: Partial<ControlDeps> = {}) {
  const log: string[] = [];
  let up = true;
  const d: ControlDeps = {
    platform: "linux", home: "/h", uid: 501,
    exists: () => false,
    exec: (cmd, args) => { log.push(`${cmd} ${args.join(" ")}`); return { status: 0, stdout: "" }; },
    ipcShutdown: async () => { log.push("ipc shutdown"); up = false; },
    socketUp: async () => up,
    readPid: () => 4242,
    kill: (pid, sig) => { log.push(`kill ${pid} ${sig}`); },
    sleep: async () => {},
    spawnDaemon: () => { log.push("spawn"); },
    out: () => {},
    ...over,
  };
  return { d, log };
}

test("linux: an installed, active unit is stopped through systemctl and nothing else", async () => {
  const { d, log } = mk({ exists: (p) => p === servicePaths("/h").systemd });
  assert.equal(await stopDaemon(d), "service");
  assert.deepEqual(log, ["systemctl --user is-active --quiet aibroker.service", "systemctl --user stop aibroker.service"]);
});

test("macOS: an installed, loaded agent is booted out", async () => {
  const { d, log } = mk({ platform: "darwin", exists: (p) => p === servicePaths("/h").launchd });
  assert.equal(await stopDaemon(d), "service");
  assert.equal(log[1], "launchctl bootout gui/501/com.aibroker.daemon");
});

test("an installed but inactive unit falls through to IPC", async () => {
  const { d, log } = mk({
    exists: () => true,
    exec: (cmd, args) => { log.push(`${cmd} ${args[1]}`); return { status: 3, stdout: "" }; },
  });
  assert.equal(await stopDaemon(d), "ipc");
  assert.ok(log.includes("ipc shutdown"));
  assert.ok(!log.some((l) => l.startsWith("kill")));
});

test("no service, unreachable IPC: the pidfile is signalled", async () => {
  const { d, log } = mk({ ipcShutdown: async () => { throw new Error("ECONNREFUSED"); } });
  assert.equal(await stopDaemon(d), "pidfile");
  assert.deepEqual(log, ["kill 4242 0", "kill 4242 SIGTERM"]);
});

test("a stale pidfile (dead pid) is not a stop", async () => {
  const { d } = mk({
    ipcShutdown: async () => { throw new Error("ECONNREFUSED"); },
    kill: () => { throw new Error("ESRCH"); },
  });
  await assert.rejects(stopDaemon(d), /not running/);
});

test("no service, no pidfile, no answer: says not running", async () => {
  const { d } = mk({ ipcShutdown: async () => { throw new Error("x"); }, readPid: () => null });
  await assert.rejects(stopDaemon(d), /not running/);
});

test("restart drives the service itself; without one it stops and starts detached", async () => {
  const svc = mk({ exists: () => true });
  assert.equal(await restartDaemon(svc.d), "service");
  assert.ok(svc.log.includes("systemctl --user restart aibroker.service"));

  const bare = mk();
  assert.equal(await restartDaemon(bare.d), "started");
  assert.deepEqual(bare.log.filter((l) => l === "ipc shutdown" || l === "spawn"), ["ipc shutdown", "spawn"]);
});
