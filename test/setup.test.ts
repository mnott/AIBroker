import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HOOK_PLAN, cliJs, claudeJsonPath, envFilePath, mcpJs, mergeHooks, parseOpts, plistPath, renderPlist, renderUnit, settingsPath, setup, stableNodePath, uninstall, unitPath, runSetup, runUninstall,
  type Sys,
} from "../src/daemon/setup.js";
import { diagnose } from "../src/daemon/doctor.js";

interface Fake { sys: Sys; calls: string[]; out: string[]; bins: Set<string>; results: Record<string, { ok: boolean; out: string }> }

function fake(platform: NodeJS.Platform, bins: string[], env: NodeJS.ProcessEnv = {}): Fake {
  const root = mkdtempSync(join(tmpdir(), "aib-setup-"));
  const home = join(root, "home");
  const pkgRoot = join(root, "pkg");
  mkdirSync(home, { recursive: true });
  for (const f of ["dist/daemon/cli.js", "dist/mcp/index.js", ...HOOK_PLAN.map((h) => `hooks/${h.file}`)]) {
    mkdirSync(join(pkgRoot, f, ".."), { recursive: true });
    writeFileSync(join(pkgRoot, f), "");
  }
  cpSync(join(process.cwd(), "templates"), join(pkgRoot, "templates"), { recursive: true });
  const f: Fake = { calls: [], out: [], bins: new Set(bins), results: {}, sys: undefined as unknown as Sys };
  f.sys = {
    home, platform, pkgRoot, user: "tester", uid: 501, nodeVersion: "v22.1.0", execPath: "/opt/node/bin/node",
    env: { PATH: "/opt/node/bin:/usr/bin", ...env },
    which: (b) => (f.bins.has(b) ? `/usr/bin/${b}` : null),
    run: (cmd, args) => {
      const line = [cmd.replace("/usr/bin/", ""), ...args].join(" ");
      f.calls.push(line);
      return f.results[line] ?? { ok: true, out: "" };
    },
  };
  return f;
}

const say = (f: Fake) => (l: string) => f.out.push(l);
const opts = (...a: string[]) => parseOpts(a);
const mutating = (f: Fake) => f.calls.filter((c) => !/^loginctl show-user/.test(c));

test("linux unit: absolute node + cli.js, no placeholders, PATH captured", () => {
  const f = fake("linux", ["systemctl", "loginctl"]);
  const unit = renderUnit(f.sys);
  assert.match(unit, new RegExp(`^ExecStart=/opt/node/bin/node ${cliJs(f.sys).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} start$`, "m"));
  assert.doesNotMatch(unit, /@[A-Z_]+@/);
  assert.match(unit, /^Environment="PATH=\/opt\/node\/bin:\/usr\/bin"$/m);
  assert.match(unit, /^EnvironmentFile=-%h\/\.aibroker\/env$/m);
  assert.match(unit, /^UMask=0077$/m);
});

test("unit and plist do not copy variables the env file already defines", () => {
  const f = fake("linux", [], { AIBROKER_TRANSPORT: "tmux", AIBROKER_SECRET: "s3cr3t" });
  mkdirSync(join(f.sys.home, ".aibroker"), { recursive: true });
  writeFileSync(envFilePath(f.sys), "AIBROKER_SECRET=s3cr3t\n");
  const unit = renderUnit(f.sys);
  assert.match(unit, /AIBROKER_TRANSPORT=tmux/);
  assert.doesNotMatch(unit, /s3cr3t/);
  assert.doesNotMatch(renderPlist(f.sys), /s3cr3t/);
});

test("plist: ProgramArguments, escaped env, log under ~/.aibroker", () => {
  const f = fake("darwin", [], { AIBROKER_X: "a<b&c" });
  const p = renderPlist(f.sys);
  assert.match(p, /<string>\/opt\/node\/bin\/node<\/string>\s*<string>[^<]*dist\/daemon\/cli\.js<\/string>\s*<string>start<\/string>/);
  assert.match(p, /<key>AIBROKER_X<\/key><string>a&lt;b&amp;c<\/string>/);
  assert.match(p, /\.aibroker\/daemon\.log/);
});

test("linux setup writes unit, env, mcp, hooks, runs systemctl, warns on linger", () => {
  const f = fake("linux", ["systemctl", "loginctl"]);
  f.results["loginctl show-user tester -p Linger"] = { ok: true, out: "Linger=no\n" };
  assert.equal(setup(f.sys, opts(), say(f)), 0);
  assert.ok(existsSync(unitPath(f.sys)));
  assert.equal(readFileSync(unitPath(f.sys), "utf8"), renderUnit(f.sys));
  assert.ok(existsSync(envFilePath(f.sys)));
  const mcp = JSON.parse(readFileSync(claudeJsonPath(f.sys), "utf8"));
  assert.deepEqual(mcp.mcpServers.aibroker.args, [mcpJs(f.sys)]);
  const settings = JSON.parse(readFileSync(settingsPath(f.sys), "utf8"));
  assert.equal(settings.hooks.UserPromptSubmit.length, 2);
  assert.equal(settings.hooks.Stop.length, 1);
  assert.equal(settings.hooks.PreToolUse.length, 2);
  assert.ok(f.calls.includes("systemctl --user daemon-reload"));
  assert.ok(f.calls.includes("systemctl --user enable --now aibroker.service"));
  assert.match(f.out.join("\n"), /sudo loginctl enable-linger tester/);
});

const SHOW = "loginctl show-user tester -p Linger";
const ENABLE = "loginctl --no-ask-password enable-linger tester";

test("linger already on: no enable call", () => {
  const f = fake("linux", ["systemctl", "loginctl"]);
  f.results[SHOW] = { ok: true, out: "Linger=yes\n" };
  setup(f.sys, opts(), say(f));
  assert.ok(!f.calls.includes(ENABLE));
  assert.match(f.out.join("\n"), /linger: on/);
});

test("linger off, enable succeeds: setup enables it without sudo", () => {
  const f = fake("linux", ["systemctl", "loginctl"]);
  f.results[SHOW] = { ok: true, out: "Linger=no\n" };
  const run = f.sys.run;
  f.sys.run = (cmd, args) => {
    const r = run(cmd, args);
    if ([cmd.replace("/usr/bin/", ""), ...args].join(" ") === ENABLE) f.results[SHOW] = { ok: true, out: "Linger=yes\n" };
    return r;
  };
  setup(f.sys, opts(), say(f));
  assert.ok(f.calls.includes(ENABLE));
  assert.ok(!f.calls.some((c) => c.startsWith("sudo")));
  assert.match(f.out.join("\n"), /linger: on \(service survives logout\)/);
  assert.doesNotMatch(f.out.join("\n"), /sudo/);
});

test("linger off, enable refused: sudo advice", () => {
  const f = fake("linux", ["systemctl", "loginctl"]);
  f.results[SHOW] = { ok: true, out: "Linger=no\n" };
  f.results[ENABLE] = { ok: false, out: "denied" };
  setup(f.sys, opts(), say(f));
  assert.ok(f.calls.includes(ENABLE));
  assert.match(f.out.join("\n"), /sudo loginctl enable-linger tester/);
});

test("setup is idempotent: second run changes nothing and adds no duplicate hooks", () => {
  const f = fake("linux", ["systemctl", "loginctl"]);
  setup(f.sys, opts(), say(f));
  const before = [unitPath, envFilePath, claudeJsonPath, settingsPath].map((p) => readFileSync(p(f.sys), "utf8"));
  f.calls.length = 0; f.out.length = 0;
  assert.equal(setup(f.sys, opts(), say(f)), 0);
  assert.deepEqual([unitPath, envFilePath, claudeJsonPath, settingsPath].map((p) => readFileSync(p(f.sys), "utf8")), before);
  assert.ok(!f.calls.includes("systemctl --user restart aibroker.service"));
  assert.match(f.out.join("\n"), /unit unchanged/);
  assert.match(f.out.join("\n"), /already registered/);
});

test("dry run writes nothing and runs no mutating command", () => {
  const f = fake("linux", ["systemctl", "loginctl", "claude"]);
  assert.equal(setup(f.sys, opts("--dry-run"), say(f)), 0);
  for (const p of [unitPath, envFilePath, claudeJsonPath, settingsPath]) assert.equal(existsSync(p(f.sys)), false);
  assert.deepEqual(mutating(f), []);
  const text = f.out.join("\n");
  assert.match(text, /would write .*aibroker\.service/);
  assert.match(text, /would run: systemctl --user enable --now aibroker\.service/);
  assert.match(text, /would run: \/usr\/bin\/claude mcp add --scope user aibroker --/);
  assert.match(text, /would add: Stop aibroker-route-guard\.mjs/);
});

test("mcp: uses the claude CLI when present, JSON merge otherwise, other servers untouched", () => {
  const withCli = fake("linux", ["claude"]);
  setup(withCli.sys, opts("--no-service", "--no-hooks"), say(withCli));
  assert.ok(withCli.calls.includes(`claude mcp add --scope user aibroker -- /opt/node/bin/node ${mcpJs(withCli.sys)}`));
  // the CLI exited 0 but wrote nothing: setup must verify and fall back
  assert.equal(JSON.parse(readFileSync(claudeJsonPath(withCli.sys), "utf8")).mcpServers.aibroker.args[0], mcpJs(withCli.sys));
  assert.ok(withCli.out.some((l) => /did not register it; wrote ~\/\.claude\.json directly/.test(l)));

  const noCli = fake("linux", []);
  writeFileSync(claudeJsonPath(noCli.sys), JSON.stringify({ theme: "dark", mcpServers: { other: { command: "x" } } }));
  setup(noCli.sys, opts("--no-service", "--no-hooks"), say(noCli));
  const cfg = JSON.parse(readFileSync(claudeJsonPath(noCli.sys), "utf8"));
  assert.equal(cfg.theme, "dark");
  assert.deepEqual(cfg.mcpServers.other, { command: "x" });
  assert.equal(cfg.mcpServers.aibroker.command, "/opt/node/bin/node");
  assert.ok(existsSync(`${claudeJsonPath(noCli.sys)}.bak`));
});

test("mcp: a current entry is left alone; a dangling target or stale node command is re-registered", () => {
  const f = fake("linux", []);
  const entry = (command: string, target: string) => JSON.stringify({ mcpServers: { aibroker: { command, args: [target] } } });
  const args = () => JSON.parse(readFileSync(claudeJsonPath(f.sys), "utf8")).mcpServers.aibroker;
  writeFileSync(claudeJsonPath(f.sys), entry(f.sys.execPath, mcpJs(f.sys)));
  setup(f.sys, opts("--no-service", "--no-hooks"), say(f));
  assert.match(f.out.join("\n"), /left alone/);
  assert.deepEqual(f.calls, []);

  writeFileSync(claudeJsonPath(f.sys), entry(f.sys.execPath, join(f.sys.home, "gone.js")));
  setup(f.sys, opts("--no-service", "--no-hooks"), say(f));
  assert.deepEqual(args().args, [mcpJs(f.sys)]);

  const stale = "/opt/homebrew/Cellar/node/26.7.0/bin/node";
  writeFileSync(claudeJsonPath(f.sys), entry(stale, mcpJs(f.sys)));
  f.out.length = 0;
  setup(f.sys, opts("--no-service", "--no-hooks", "--dry-run"), say(f));
  assert.equal(args().command, stale);
  assert.match(f.out.join("\n"), /updating to/);
  setup(f.sys, opts("--no-service", "--no-hooks"), say(f));
  assert.equal(args().command, f.sys.execPath);
});

test("mcp: a stale node command goes through claude mcp remove + add", () => {
  const f = fake("linux", ["claude"]);
  writeFileSync(claudeJsonPath(f.sys), JSON.stringify({ mcpServers: { aibroker: { command: "/old/node", args: [mcpJs(f.sys)] } } }));
  setup(f.sys, opts("--no-service", "--no-hooks"), say(f));
  assert.deepEqual(f.calls, [
    "claude mcp remove --scope user aibroker",
    `claude mcp add --scope user aibroker -- ${f.sys.execPath} ${mcpJs(f.sys)}`,
  ]);
});

test("hooks: stale node commands are rewritten in place; current ones are untouched", () => {
  const f = fake("linux", []);
  const stale = "/opt/homebrew/Cellar/node/26.7.0/bin/node";
  const foreign = { hooks: [{ type: "command", command: "node /x/foreign.mjs" }] };
  const hooks: Record<string, any[]> = {};
  for (const h of HOOK_PLAN) {
    const cmd = `${stale} ${join(f.sys.pkgRoot, "hooks", h.file)}`;
    (hooks[h.event] ??= []).push({ ...(h.matcher ? { matcher: h.matcher } : {}), hooks: [{ type: "command", command: cmd }] });
  }
  hooks.Stop = [...(hooks.Stop ?? []), foreign];
  const before = { model: "m", hooks };
  const r = mergeHooks(structuredClone(before), f.sys);
  assert.equal(r.updated.length, HOOK_PLAN.length);
  assert.deepEqual(r.added, []);
  assert.deepEqual(r.present, []);
  for (const [ev, groups] of Object.entries(r.settings.hooks as Record<string, any[]>)) {
    assert.equal(groups.length, hooks[ev].length);
    groups.forEach((g, i) => {
      assert.equal(g.matcher, hooks[ev][i].matcher);
      if (g !== foreign && g.hooks[0].command !== foreign.hooks[0].command) assert.ok(g.hooks[0].command.startsWith(`${f.sys.execPath} `));
    });
  }
  assert.deepEqual(r.settings.hooks.Stop.at(-1), foreign);
  assert.deepEqual(before.hooks, hooks);

  const again = mergeHooks(r.settings, f.sys);
  assert.deepEqual(again.updated, []);
  assert.deepEqual(again.added, []);
  assert.equal(again.present.length, HOOK_PLAN.length);
  assert.deepEqual(again.settings, r.settings);
});

test("invalid JSON in claude.json or settings.json is never overwritten", () => {
  const f = fake("linux", []);
  mkdirSync(join(f.sys.home, ".claude"), { recursive: true });
  writeFileSync(claudeJsonPath(f.sys), "{ not json");
  writeFileSync(settingsPath(f.sys), "{ not json");
  assert.equal(setup(f.sys, opts("--no-service"), say(f)), 2);
  assert.equal(readFileSync(claudeJsonPath(f.sys), "utf8"), "{ not json");
  assert.equal(readFileSync(settingsPath(f.sys), "utf8"), "{ not json");
});

test("hooks: merge keeps foreign hooks, re-points ones wired from another install dir, uninstall removes only ours", () => {
  const f = fake("linux", []);
  mkdirSync(join(f.sys.home, ".claude"), { recursive: true });
  const foreign = { hooks: [{ type: "command", command: "node /x/foreign.mjs" }] };
  const elsewhere = { hooks: [{ type: "command", command: "node /dev/AIBroker/hooks/drain-mailbox.mjs" }] };
  writeFileSync(settingsPath(f.sys), JSON.stringify({ model: "m", hooks: { UserPromptSubmit: [foreign, elsewhere], Stop: [foreign] } }));
  setup(f.sys, opts("--no-service", "--no-mcp"), say(f));
  let s = JSON.parse(readFileSync(settingsPath(f.sys), "utf8"));
  assert.equal(s.model, "m");
  const cmds = (e: string) => s.hooks[e].flatMap((g: any) => g.hooks.map((h: any) => h.command));
  assert.equal(cmds("UserPromptSubmit").filter((c: string) => c.includes("drain-mailbox")).length, 1);
  assert.ok(cmds("UserPromptSubmit").some((c: string) => c.includes(f.sys.pkgRoot) && c.includes("manage-hook.mjs")));
  assert.ok(s.hooks.PreToolUse.some((g: any) => g.matcher === "mcp__aibroker__aibroker_rename"));

  uninstall(f.sys, opts("--no-service", "--no-mcp"), say(f));
  s = JSON.parse(readFileSync(settingsPath(f.sys), "utf8"));
  assert.deepEqual(s.hooks, { UserPromptSubmit: [foreign], Stop: [foreign] });
});

test("uninstall removes unit and mcp entry, keeps ~/.aibroker unless --purge", () => {
  const f = fake("linux", ["systemctl"]);
  setup(f.sys, opts(), say(f));
  f.calls.length = 0;
  uninstall(f.sys, opts(), say(f));
  assert.equal(existsSync(unitPath(f.sys)), false);
  assert.ok(f.calls.includes("systemctl --user disable --now aibroker.service"));
  assert.equal(JSON.parse(readFileSync(claudeJsonPath(f.sys), "utf8")).mcpServers.aibroker, undefined);
  assert.ok(existsSync(envFilePath(f.sys)));
  uninstall(f.sys, opts("--purge"), say(f));
  assert.equal(existsSync(join(f.sys.home, ".aibroker")), false);
});

test("backup: setup then uninstall keeps .bak as the original", () => {
  const f = fake("linux", []);
  mkdirSync(join(f.sys.home, ".claude"), { recursive: true });
  const original = JSON.stringify({ model: "m" });
  writeFileSync(settingsPath(f.sys), original);
  setup(f.sys, opts("--no-service", "--no-mcp"), say(f));
  uninstall(f.sys, opts("--no-service", "--no-mcp"), say(f));
  assert.equal(readFileSync(`${settingsPath(f.sys)}.bak`, "utf8"), original);
});

test("macOS: an existing plist is left alone without --force, replaced with it", () => {
  const f = fake("darwin", []);
  mkdirSync(join(f.sys.home, "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(plistPath(f.sys), "<plist><string>old</string></plist>");
  setup(f.sys, opts("--no-mcp", "--no-hooks"), say(f));
  assert.equal(readFileSync(plistPath(f.sys), "utf8"), "<plist><string>old</string></plist>");
  assert.deepEqual(mutating(f), []);
  assert.match(f.out.join("\n"), /left alone \(use --force/);

  setup(f.sys, opts("--no-mcp", "--no-hooks", "--force"), say(f));
  assert.equal(readFileSync(plistPath(f.sys), "utf8"), renderPlist(f.sys));
  assert.ok(f.calls.includes(`launchctl bootstrap gui/501 ${plistPath(f.sys)}`));
});

test("macOS: fresh setup writes the plist and bootstraps it", () => {
  const f = fake("darwin", []);
  setup(f.sys, opts("--no-mcp", "--no-hooks"), say(f));
  assert.equal(readFileSync(plistPath(f.sys), "utf8"), renderPlist(f.sys));
  assert.ok(f.calls.includes(`launchctl bootstrap gui/501 ${plistPath(f.sys)}`));
});

// ── doctor ────────────────────────────────────────────────────────────────

const byName = (cs: Awaited<ReturnType<typeof diagnose>>, n: string) => cs.filter((c) => c.name === n);

test("doctor: fresh linux host reports each missing piece with a fix", async () => {
  const f = fake("linux", []);
  const cs = await diagnose(f.sys, { ping: async () => false });
  for (const n of ["tmux", "service", "daemon socket", "mcp entry", "hooks"]) {
    const c = byName(cs, n)[0];
    assert.equal(c.level, "FAIL", n);
    assert.ok(c.fix, `${n} has a fix`);
  }
  assert.equal(byName(cs, "transport")[0].detail, "linux: tmux");
});

test("doctor: after setup, with a live daemon, nothing required fails", async () => {
  const f = fake("linux", ["tmux", "systemctl", "loginctl", "ffmpeg"]);
  f.results["systemctl --user is-active aibroker.service"] = { ok: true, out: "active\n" };
  f.results["loginctl show-user tester -p Linger"] = { ok: true, out: "Linger=yes\n" };
  f.results["tmux -V"] = { ok: true, out: "tmux 3.4\n" };
  setup(f.sys, opts(), say(f));
  const cs = await diagnose(f.sys, { ping: async () => true });
  assert.deepEqual(cs.filter((c) => c.level === "FAIL"), []);
  assert.equal(byName(cs, "linger")[0].level, "ok");
});

test("doctor: old node, dangling mcp target, loose env file mode", async () => {
  const f = fake("linux", ["tmux"]);
  (f.sys as { nodeVersion: string }).nodeVersion = "v20.11.0";
  writeFileSync(claudeJsonPath(f.sys), JSON.stringify({ mcpServers: { aibroker: { args: ["/nope/index.js"] } } }));
  mkdirSync(join(f.sys.home, ".aibroker"), { recursive: true });
  writeFileSync(envFilePath(f.sys), "A=1\n");
  chmodSync(envFilePath(f.sys), 0o644);
  const cs = await diagnose(f.sys, { ping: async () => true });
  assert.equal(byName(cs, "node")[0].level, "FAIL");
  assert.match(byName(cs, "mcp entry")[0].detail, /missing file/);
  assert.equal(byName(cs, "env file")[0].fix, `chmod 600 ${envFilePath(f.sys)}`);
});

for (const [name, run] of [["setup", runSetup], ["uninstall", runUninstall]] as const) {
  for (const flag of ["--help", "-h"]) {
    test(`${name} ${flag}: usage, no side effects`, async () => {
      const f = fake("darwin", []);
      await run([flag], f.sys, say(f));
      assert.equal(process.exitCode, 0);
      assert.match(f.out.join("\n"), new RegExp(`usage: aibroker ${name}.*--dry-run`));
      assert.deepEqual(f.calls, []);
      assert.equal(existsSync(settingsPath(f.sys)), false);
      assert.equal(existsSync(plistPath(f.sys)), false);
    });
  }
  test(`${name} unknown flag: error, no side effects`, async () => {
    const f = fake("darwin", []);
    await run(["--dryrun"], f.sys, say(f));
    assert.equal(process.exitCode, 1);
    assert.match(f.out.join("\n"), /unknown option: --dryrun/);
    assert.match(f.out.join("\n"), /usage: aibroker/);
    assert.deepEqual(f.calls, []);
    assert.equal(existsSync(settingsPath(f.sys)), false);
    assert.equal(existsSync(plistPath(f.sys)), false);
    process.exitCode = 0;
  });
}

test("stableNodePath: Cellar execPath maps to the PATH alias", () => {
  const cellar = "/opt/homebrew/Cellar/node/26.7.0/bin/node";
  const rp = (p: string) => {
    if (p === cellar || p === "/opt/homebrew/bin/node") return cellar;
    throw new Error("ENOENT");
  };
  assert.equal(stableNodePath(cellar, "/usr/bin:/opt/homebrew/bin", rp), "/opt/homebrew/bin/node");
});

test("stableNodePath: no matching entry returns execPath; first match wins", () => {
  const exec = "/home/u/.nvm/v22/bin/node";
  const rp = (p: string) => (p === exec || p === "/a/node" || p === "/b/node" ? exec : "/other");
  assert.equal(stableNodePath(exec, "/usr/bin", () => { throw new Error("x"); }), exec);
  assert.equal(stableNodePath(exec, "/usr/bin", (p) => (p === exec ? exec : "/other")), exec);
  assert.equal(stableNodePath(exec, "/a:/b", rp), "/a/node");
});
