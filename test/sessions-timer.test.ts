import "./home-guard.js";
/**
 * test/sessions-timer.test.ts — snapshot timer (systemd user units / launchd
 * plist) and restore through the transport launch path. Temp HOME, injected
 * run/launch: no systemctl, launchctl or tmux is called.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serviceEnv } from "../src/core/service-env.js";
import { installAgent, renderSnapshotUnits, restoreEntries, uninstallAgent, type AgentIo } from "../src/daemon/sessions.js";

function io(platform: NodeJS.Platform, run: string[] = []): { io: AgentIo; home: string; run: string[]; out: string[] } {
  const home = mkdtempSync(join(tmpdir(), "aib-timer-"));
  const out: string[] = [];
  return {
    home, run, out,
    io: {
      platform, home, uid: 501, execPath: "/opt/node/bin/node", cliPath: "/opt/aibroker/dist/daemon/cli.js",
      env: { PATH: "/opt/node/bin:/usr/bin", AIBROKER_TRANSPORT: "tmux", OTHER: "no" },
      run: (c) => { run.push(c); }, log: join(home, ".aibroker", "sessions-snapshot.log"), out: (l) => out.push(l),
    },
  };
}

test("serviceEnv captures PATH and AIBROKER_* only", () => {
  assert.deepEqual(serviceEnv({ PATH: "/p", AIBROKER_X: "1", HOME: "/h" }), { PATH: "/p", AIBROKER_X: "1" });
});

test("linux: writes the service + timer with PATH/AIBROKER_* and a 5 min cadence, enables the timer", () => {
  const t = io("linux");
  installAgent(t.io);
  const dir = join(t.home, ".config", "systemd", "user");
  const svc = readFileSync(join(dir, "aibroker-sessions-snapshot.service"), "utf8");
  const timer = readFileSync(join(dir, "aibroker-sessions-snapshot.timer"), "utf8");
  assert.match(svc, /Type=oneshot/);
  assert.match(svc, /Environment="PATH=\/opt\/node\/bin:\/usr\/bin"/);
  assert.match(svc, /Environment="AIBROKER_TRANSPORT=tmux"/);
  assert.doesNotMatch(svc, /OTHER/);
  assert.match(svc, /ExecStart="\/opt\/node\/bin\/node" "\/opt\/aibroker\/dist\/daemon\/cli.js" sessions snapshot/);
  assert.match(timer, /OnUnitActiveSec=5min/);
  assert.match(timer, /WantedBy=timers.target/);
  assert.deepEqual(t.run, ["systemctl --user daemon-reload", "systemctl --user enable --now aibroker-sessions-snapshot.timer"]);
  assert.ok(!existsSync(join(t.home, "Library")), "no launchd plist on linux");
});

test("linux: uninstall removes both units and disables the timer", () => {
  const t = io("linux");
  installAgent(t.io);
  t.run.length = 0;
  uninstallAgent(t.io);
  const dir = join(t.home, ".config", "systemd", "user");
  assert.ok(!existsSync(join(dir, "aibroker-sessions-snapshot.timer")));
  assert.ok(!existsSync(join(dir, "aibroker-sessions-snapshot.service")));
  assert.equal(t.run[0], "systemctl --user disable --now aibroker-sessions-snapshot.timer");
});

test("systemd values are quoted and % is doubled", () => {
  const u = renderSnapshotUnits({ execPath: "/n", cliPath: "/c d/cli.js", env: { PATH: "/a%b" }, log: "/l" });
  assert.match(u.service, /Environment="PATH=\/a%%b"/);
  assert.match(u.service, /"\/c d\/cli.js"/);
});

test("macOS keeps the launchd agent", () => {
  const t = io("darwin");
  installAgent(t.io);
  const plist = readFileSync(join(t.home, "Library", "LaunchAgents", "com.aibroker.sessions-snapshot.plist"), "utf8");
  assert.match(plist, /<key>StartInterval<\/key><integer>300<\/integer>/);
  assert.match(plist, /<key>AIBROKER_TRANSPORT<\/key><string>tmux<\/string>/);
  assert.equal(t.run[1], `launchctl bootstrap gui/501 ${join(t.home, "Library", "LaunchAgents", "com.aibroker.sessions-snapshot.plist")}`);
  assert.ok(!existsSync(join(t.home, ".config", "systemd")));
});

test("restore reopens each entry through launch (resume), skipping missing dirs", () => {
  const calls: unknown[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const n = restoreEntries(
    [{ name: "api", cwd: "/w/api" }, { name: "gone", cwd: "/w/gone" }],
    false,
    {
      launch: (o) => { calls.push(o); return { id: "u1", transport: "tmux", where: "w" }; },
      exists: (p) => p !== "/w/gone", sleep: () => {}, out: (l) => out.push(l), err: (l) => err.push(l),
    },
  );
  assert.equal(n, 1);
  assert.deepEqual(calls, [{ dir: "/w/api", name: "api", resume: true }]);
  assert.match(err.join(), /missing dir\): \/w\/gone/);
  assert.match(out.join("\n"), /\[tmux u1\]/);
});

test("restore --dry-run launches nothing", () => {
  let launched = 0;
  restoreEntries([{ name: "a", cwd: "/a" }], true, { launch: () => { launched++; return null; }, exists: () => true, sleep: () => {}, out: () => {}, err: () => {} });
  assert.equal(launched, 0);
});
