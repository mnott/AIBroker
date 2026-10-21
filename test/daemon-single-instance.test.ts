import "./home-guard.js";
/**
 * test/daemon-single-instance.test.ts — the 2026-10-21 incident, three ways:
 *   1. `aibroker start --help` printed no help and started a SECOND daemon in
 *      the foreground; a bare `aibroker` started one too. Help is an answer,
 *      never an action, and a bare invocation prints the command list.
 *   2. `start` accepted a second daemon alongside a live one (both connected
 *      to PAILot). A live pid file or an answering socket now refuses; a
 *      dead-pid lock is stale and gets taken over.
 *   3. The socket FILE was deleted while the daemon kept listening — clients
 *      failed for hours while the daemon looked healthy. The guard re-listens.
 *
 * No real launchd, no live daemon: the CLI runs as a child process under a
 * sandbox HOME (home-guard) with a temp socket; the lock and the guard are
 * exercised with injected deps and a real temp-dir socket.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { IpcServer } from "../src/ipc/server.js";
import { liveDaemonPid, startSocketGuard, alreadyRunningMessage, type InstanceDeps } from "../src/daemon/daemon-instance.js";

const CLI = join(import.meta.dirname, "..", "src", "daemon", "cli.ts");

function runCli(args: string[]): { code: number | null; stdout: string; stderr: string } {
  // tsx as the runner, exactly as `npm test` runs it: process.execPath here is
  // a plain node and cannot load cli.ts itself.
  const r = spawnSync("npx", ["tsx", "--import", "./test/home-guard.ts", CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "aibroker-instance-"));
}

test("start --help prints start's help, exits 0, and starts nothing", () => {
  const dir = tempDir();
  const socket = join(dir, "aibroker.sock");
  try {
    const r = runCli(["start", "--help", "--socket", socket]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Usage: aibroker start/);
    assert.ok(!existsSync(socket), "help must not start a daemon — no socket appears");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("-h on any subcommand prints that subcommand's help and exits 0", () => {
  const r = runCli(["launch", "-h"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Usage: aibroker launch/);
});

test("a bare aibroker prints the command list and starts nothing", () => {
  const r = runCli([]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Commands:/);
  assert.match(r.stdout, /start/);
});

function mkInstance(over: Partial<InstanceDeps> = {}): { d: InstanceDeps; lines: string[] } {
  const lines: string[] = [];
  const d: InstanceDeps = {
    pidFile: "/h/.aibroker/daemon.pid",
    socketPath: "/tmp/aibroker.sock",
    readPid: () => null,
    pidAlive: () => false,
    socketUp: async () => false,
    removePidFile: () => {},
    out: (l) => lines.push(l),
    ...over,
  };
  return { d, lines };
}

test("a live pid in the lock refuses a second start and names the pid", async () => {
  const { d } = mkInstance({ readPid: () => 4242, pidAlive: (p) => p === 4242 });
  assert.equal(await liveDaemonPid(d), 4242);
  assert.match(alreadyRunningMessage(4242, d.socketPath), /already running \(pid 4242/);
  assert.match(alreadyRunningMessage(4242, d.socketPath), /aibroker restart/);
});

test("a dead-pid lock is stale: removed, and the start proceeds", async () => {
  let removed = false;
  const { d, lines } = mkInstance({
    readPid: () => 9999,
    pidAlive: () => false,
    removePidFile: () => {
      removed = true;
    },
  });
  assert.equal(await liveDaemonPid(d), null);
  assert.ok(removed, "the stale lock is taken over");
  assert.match(lines.join("\n"), /stale daemon lock \(pid 9999/);
});

test("no pid file but an answering socket is still a live daemon — refused", async () => {
  const { d } = mkInstance({ readPid: () => null, socketUp: async () => true });
  assert.equal(await liveDaemonPid(d), -1);
  assert.match(alreadyRunningMessage(-1, d.socketPath), /answers on/);
});

test("nothing live: the way is clear", async () => {
  const { d } = mkInstance();
  assert.equal(await liveDaemonPid(d), null);
});

test("socket file deleted from under a live listener -> re-created by the check", async () => {
  const dir = tempDir();
  const socketPath = join(dir, "aibroker.sock");
  const logged: string[] = [];
  const server = new IpcServer(socketPath);
  server.start();
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  assert.ok(existsSync(socketPath), "the listener created the socket file");

  const stopGuard = startSocketGuard({
    socketPath,
    intervalMs: 20,
    close: () => server.reListen(),
    reListen: () => {},
    log: (l) => logged.push(l),
  });

  try {
    // The incident: the FILE goes, the listener stays healthy — nothing a
    // client can see except its own failure.
    unlinkSync(socketPath);
    assert.ok(!existsSync(socketPath));

    for (let waited = 0; waited < 2_000; waited += 25) {
      if (existsSync(socketPath)) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(existsSync(socketPath), "the guard re-created the socket file");
    assert.ok(statSync(socketPath).isSocket());
    assert.deepEqual(logged, ["socket file was removed; re-created"]);

    // And clients work again on the re-created path.
    const got = await new Promise<string>((resolve, reject) => {
      const sock = connect(socketPath);
      sock.on("data", (b: Buffer) => {
        resolve(b.toString());
        sock.destroy();
      });
      sock.on("error", reject);
      sock.write(JSON.stringify({ id: "1", sessionId: "t", method: "nope", params: {} }) + "\n");
    });
    assert.match(got, /Unknown method/);
  } finally {
    stopGuard();
    server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
