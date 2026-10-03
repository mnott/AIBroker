/**
 * daemon/setup.ts — `aibroker setup` / `aibroker uninstall`.
 *
 * One idempotent command wires the four things a user otherwise does by hand:
 * the service (systemd --user on Linux, LaunchAgent on macOS), the MCP server
 * registration for Claude Code, the Claude Code hooks, and ~/.aibroker/env.
 * Every host fact (home, platform, which binaries exist, running a command) is
 * behind `Sys`, so tests run under a temp HOME without touching the machine.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBin } from "../core/bins.js";
import { plistEnvEntries, serviceEnv, xmlEscape } from "../core/service-env.js";

export interface Sys {
  home: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  execPath: string;
  nodeVersion: string;
  /** Root of the installed aibroker package (holds dist/, hooks/, templates/). */
  pkgRoot: string;
  user: string;
  uid: number;
  /** Absolute path of a binary, or null when it is not installed. */
  which(bin: string): string | null;
  /** Run a command; never throws. */
  run(cmd: string, args: string[]): { ok: boolean; out: string };
}

/**
 * The first `node` on PATH that is the running binary, so a versioned path
 * (Homebrew Cellar) becomes its stable alias. Falls back to execPath.
 */
export function stableNodePath(execPath: string, pathEnv: string, realpath: (p: string) => string): string {
  try {
    const want = realpath(execPath);
    for (const dir of pathEnv.split(delimiter)) {
      if (!dir) continue;
      const cand = join(dir, "node");
      try { if (realpath(cand) === want) return cand; } catch { /* not on this entry */ }
    }
  } catch { /* execPath unresolvable */ }
  return execPath;
}

export function realSys(): Sys {
  const home = process.env.HOME || userInfo().homedir;
  return {
    home,
    platform: process.platform,
    env: process.env,
    execPath: stableNodePath(process.execPath, process.env.PATH ?? "", realpathSync),
    nodeVersion: process.version,
    pkgRoot: join(dirname(fileURLToPath(import.meta.url)), "..", ".."),
    user: userInfo().username,
    uid: process.getuid?.() ?? 0,
    which: (bin) => {
      const p = resolveBin(bin);
      return p !== bin ? p : null;
    },
    run: (cmd, args) => {
      const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 15_000 });
      return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
    },
  };
}

// ── paths ─────────────────────────────────────────────────────────────────

export const UNIT_NAME = "aibroker.service";
export const PLIST_LABEL = "com.aibroker.daemon";
export const unitPath = (s: Sys) => join(s.home, ".config", "systemd", "user", UNIT_NAME);
export const plistPath = (s: Sys) => join(s.home, "Library", "LaunchAgents", `${PLIST_LABEL}.plist`);
export const envFilePath = (s: Sys) => join(s.home, ".aibroker", "env");
export const daemonLogPath = (s: Sys) => join(s.home, ".aibroker", "daemon.log");
export const claudeJsonPath = (s: Sys) => join(s.home, ".claude.json");
export const settingsPath = (s: Sys) => join(s.home, ".claude", "settings.json");
export const cliJs = (s: Sys) => join(s.pkgRoot, "dist", "daemon", "cli.js");
export const mcpJs = (s: Sys) => join(s.pkgRoot, "dist", "mcp", "index.js");
export const hooksDir = (s: Sys) => join(s.pkgRoot, "hooks");

// ── hooks plan ────────────────────────────────────────────────────────────

export interface HookSpec { event: string; matcher?: string; file: string }

/**
 * Which hook file runs on which Claude Code event, from each file's own header
 * and docs/mailbox.md. budget-stop.mjs is left out on purpose: it reads PAI's
 * advisor file and only means something on a PAI install.
 */
export const HOOK_PLAN: HookSpec[] = [
  { event: "UserPromptSubmit", file: "drain-mailbox.mjs" },
  { event: "UserPromptSubmit", file: "manage-hook.mjs" },
  { event: "Stop", file: "aibroker-route-guard.mjs" },
  { event: "PreToolUse", matcher: "Task|Agent", file: "aibroker-progress.mjs" },
  { event: "PreToolUse", matcher: "mcp__aibroker__aibroker_rename", file: "aibroker-rename-title.mjs" },
];

const q = (p: string) => (/\s/.test(p) ? `"${p}"` : p);
const hookCommand = (s: Sys, file: string) => `${q(s.execPath)} ${q(join(hooksDir(s), file))}`;

type Json = Record<string, any>;
interface HookGroup { matcher?: string; hooks?: { type?: string; command?: string }[] }

const commandsIn = (settings: Json, event: string): string[] =>
  ((settings.hooks?.[event] ?? []) as HookGroup[]).flatMap((g) => (g.hooks ?? []).map((h) => h.command ?? ""));

/** Wired already, from any install dir: same hook file under any hooks/ directory. */
const hasHookFile = (settings: Json, event: string, file: string) =>
  commandsIn(settings, event).some((c) => c.includes(`/hooks/${file}`) || c.includes(`\\hooks\\${file}`));

export function mergeHooks(settings: Json, s: Sys): { settings: Json; added: string[]; present: string[] } {
  const next: Json = { ...settings, hooks: { ...(settings.hooks ?? {}) } };
  const added: string[] = [];
  const present: string[] = [];
  for (const h of HOOK_PLAN) {
    if (hasHookFile(next, h.event, h.file)) { present.push(h.file); continue; }
    const group: HookGroup = { ...(h.matcher ? { matcher: h.matcher } : {}), hooks: [{ type: "command", command: hookCommand(s, h.file) }] };
    next.hooks[h.event] = [...(next.hooks[h.event] ?? []), group];
    added.push(`${h.event}${h.matcher ? `[${h.matcher}]` : ""} ${h.file}`);
  }
  return { settings: next, added, present };
}

/** Remove exactly the entries whose command lives under this install's hooks/ dir. */
export function unmergeHooks(settings: Json, s: Sys): { settings: Json; removed: number } {
  const dir = hooksDir(s);
  let removed = 0;
  const hooks: Json = {};
  for (const [event, groups] of Object.entries((settings.hooks ?? {}) as Record<string, HookGroup[]>)) {
    const kept: HookGroup[] = [];
    for (const g of groups) {
      const keep = (g.hooks ?? []).filter((h) => !(h.command ?? "").includes(dir));
      removed += (g.hooks ?? []).length - keep.length;
      if (keep.length) kept.push({ ...g, hooks: keep });
    }
    if (kept.length) hooks[event] = kept;
  }
  const next: Json = { ...settings };
  if (Object.keys(hooks).length) next.hooks = hooks; else delete next.hooks;
  return { settings: next, removed };
}

// ── MCP entry ─────────────────────────────────────────────────────────────

/** The `aibroker` entry in ~/.claude.json: whether present and the .js it launches. */
export function readMcpEntry(s: Sys): { found: boolean; target?: string } {
  const cfg = readJson(claudeJsonPath(s));
  const e = cfg?.mcpServers?.aibroker;
  if (!e) return { found: false };
  const args: string[] = Array.isArray(e.args) ? e.args : [];
  return { found: true, target: args.find((a) => typeof a === "string" && a.endsWith(".js")) };
}

function readJson(path: string): Json | null {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")) as Json; } catch { return null; }
}

// ── rendering ─────────────────────────────────────────────────────────────

/**
 * PATH + AIBROKER_* from the invoking shell, minus what ~/.aibroker/env defines:
 * the daemon loads that file itself, and by the time setup runs the CLI has
 * already merged it into process.env, so copying it would duplicate secrets
 * into the unit and freeze them there.
 */
function captureEnv(s: Sys): Record<string, string> {
  const own = new Set((readIf(envFilePath(s)) ?? "").split("\n").map((l) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(l)?.[1]).filter(Boolean));
  const env = serviceEnv(s.env);
  for (const k of own) if (k !== "PATH") delete env[k as string];
  return env;
}

const sdQuote = (v: string) => { const e = v.replace(/%/g, "%%"); return /\s/.test(e) ? `"${e}"` : e; };

export function renderUnit(s: Sys): string {
  const template = readFileSync(join(s.pkgRoot, "templates", "systemd", UNIT_NAME), "utf8");
  const envLines = Object.entries(captureEnv(s))
    .map(([k, v]) => `Environment="${`${k}=${v}`.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`)
    .join("\n");
  return template
    .replace("@EXEC_START@", `${sdQuote(s.execPath)} ${sdQuote(cliJs(s))} start`)
    .replace("@ENVIRONMENT@", envLines);
}

export function renderPlist(s: Sys): string {
  const env = { ...captureEnv(s), HOME: s.home };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>${PLIST_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${xmlEscape(s.execPath)}</string>
        <string>${xmlEscape(cliJs(s))}</string>
        <string>start</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>${plistEnvEntries(env)}</dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>${xmlEscape(daemonLogPath(s))}</string>
    <key>StandardErrorPath</key><string>${xmlEscape(daemonLogPath(s))}</string>
</dict>
</plist>
`;
}

export const ENV_TEMPLATE = `# AIBroker environment: KEY=value per line, read by the daemon at start.
# Restart the daemon after editing (aibroker restart).
#
# AIBROKER_TRANSPORT=tmux
# PAILOT_PORT=8765
# TODOIST_API_TOKEN=
`;

// ── actions (dry-run aware) ───────────────────────────────────────────────

export interface Opts { service: boolean; mcp: boolean; hooks: boolean; dryRun: boolean; force: boolean; purge: boolean }

export function parseOpts(argv: string[]): Opts {
  return {
    service: !argv.includes("--no-service"),
    mcp: !argv.includes("--no-mcp"),
    hooks: !argv.includes("--no-hooks"),
    dryRun: argv.includes("--dry-run"),
    force: argv.includes("--force"),
    purge: argv.includes("--purge"),
  };
}

type Say = (line: string) => void;

class Act {
  fails = 0;
  constructor(readonly s: Sys, readonly dryRun: boolean, readonly say: Say) {}

  /** Outcome line; a dry run already said "would …". */
  done(line: string) { if (!this.dryRun) this.say(line); }

  fail(line: string) { this.fails++; this.say(`  FAIL  ${line}`); }

  /**
   * Atomic write; backs up the previous file. The first backup (`.bak`, the pre-aibroker original)
   * is never overwritten; later ones go to `.bak.<ISO-timestamp>`. Existing files keep their mode.
   */
  write(path: string, data: string, backup = false): void {
    if (this.dryRun) { this.say(`  would write ${path} (${data.length} bytes)`); return; }
    mkdirSync(dirname(path), { recursive: true });
    let mode = 0o600;
    if (existsSync(path)) {
      mode = statSync(path).mode & 0o777;
      if (backup) {
        const first = `${path}.bak`;
        const dest = existsSync(first) ? `${first}.${new Date().toISOString()}` : first;
        copyFileSync(path, dest);
        chmodSync(dest, 0o600);
      }
    }
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, data, { mode });
    renameSync(tmp, path);
  }

  remove(path: string, recursive = false): void {
    if (this.dryRun) { this.say(`  would remove ${path}`); return; }
    rmSync(path, { force: true, recursive });
  }

  /** A state-changing command. Dry-run prints it instead of running it. */
  run(cmd: string, args: string[]): { ok: boolean; out: string } {
    const line = [cmd, ...args].join(" ");
    if (this.dryRun) { this.say(`  would run: ${line}`); return { ok: true, out: "" }; }
    const r = this.s.run(cmd, args);
    if (!r.ok) this.say(`  command failed: ${line}${r.out.trim() ? `: ${r.out.trim()}` : ""}`);
    return r;
  }
}

const readIf = (p: string): string | null => (existsSync(p) ? readFileSync(p, "utf8") : null);

/** The `<string>` values of a plist, in order: what it runs and where it logs. The environment block is left out: it can hold secrets. */
const plistValues = (x: string) => [...x.replace(/<key>EnvironmentVariables<\/key>\s*<dict>[\s\S]*?<\/dict>/, "").matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);

function plistDiff(oldText: string, newText: string): string[] {
  const o = new Set(plistValues(oldText)), n = new Set(plistValues(newText));
  return [
    ...plistValues(oldText).filter((v) => !n.has(v)).map((v) => `      - ${v}`),
    ...plistValues(newText).filter((v) => !o.has(v)).map((v) => `      + ${v}`),
  ].slice(0, 20);
}

// ── service ───────────────────────────────────────────────────────────────

function serviceLinux(a: Act, opts: Opts): void {
  const s = a.s;
  if (!existsSync(join(s.pkgRoot, "dist", "daemon", "cli.js")) && !a.dryRun) return a.fail(`${cliJs(s)} not found; run npm run build`);
  const unit = renderUnit(s);
  const path = unitPath(s);
  const old = readIf(path);
  if (old === unit) a.say(`  unit unchanged: ${path}`);
  else { a.write(path, unit); a.done(`  ${old === null ? "wrote" : "updated"} unit: ${path}`); }
  if (opts.dryRun) a.say(`  unit content:\n${unit.split("\n").map((l) => `    | ${l}`).join("\n")}`);
  if (!s.which("systemctl")) {
    a.say(`  systemctl not found: no service started. Run it yourself: ${s.execPath} ${cliJs(s)} start`);
    return;
  }
  a.run("systemctl", ["--user", "daemon-reload"]);
  const enabled = a.run("systemctl", ["--user", "enable", "--now", UNIT_NAME]);
  if (!enabled.ok) a.fails++;
  else if (old !== null && old !== unit) a.run("systemctl", ["--user", "restart", UNIT_NAME]);
  if (!s.which("loginctl")) return;
  const lingerOn = () => /Linger=yes/.test(s.run("loginctl", ["show-user", s.user, "-p", "Linger"]).out);
  // polkit lets a user enable linger for their own account; never sudo, never prompt
  if (!lingerOn()) a.run("loginctl", ["--no-ask-password", "enable-linger", s.user]);
  if (lingerOn()) a.say("  linger: on (service survives logout)");
  else a.say(`  linger: OFF, the service stops at logout. Run once: sudo loginctl enable-linger ${s.user}`);
}

function serviceMac(a: Act, opts: Opts): void {
  const s = a.s;
  const plist = renderPlist(s);
  const path = plistPath(s);
  const old = readIf(path);
  if (old !== null && !opts.force) {
    if (old === plist) a.say(`  plist unchanged: ${path}`);
    else a.say(`  plist exists, left alone (use --force to replace): ${path}\n${plistDiff(old, plist).join("\n")}`);
    return;
  }
  if (!existsSync(cliJs(s)) && !a.dryRun) return a.fail(`${cliJs(s)} not found; run npm run build`);
  if (!existsSync(daemonLogPath(s))) a.write(daemonLogPath(s), "");
  a.write(path, plist);
  const target = `gui/${s.uid}`;
  a.run("launchctl", ["bootout", `${target}/${PLIST_LABEL}`]);
  const r = a.run("launchctl", ["bootstrap", target, path]);
  if (!r.ok) a.fails++;
  else a.done(`  ${old === null ? "wrote" : "replaced"} and loaded ${PLIST_LABEL}`);
}

// ── mcp ───────────────────────────────────────────────────────────────────

function mcpAdd(a: Act): void {
  const s = a.s;
  const entry = readMcpEntry(s);
  if (entry.found && entry.target && existsSync(entry.target)) {
    return a.say(`  aibroker entry already registered -> ${entry.target}; left alone`);
  }
  if (!existsSync(mcpJs(s)) && !a.dryRun) return a.fail(`${mcpJs(s)} not found; run npm run build`);
  const claude = s.which("claude");
  if (claude) {
    if (entry.found) a.run(claude, ["mcp", "remove", "--scope", "user", "aibroker"]);
    const r = a.run(claude, ["mcp", "add", "--scope", "user", "aibroker", "--", s.execPath, mcpJs(s)]);
    // Exit 0 is not proof: verify the artifact the same way doctor reads it.
    if (r.ok && (a.dryRun || readMcpEntry(s).target === mcpJs(s))) return a.done(`  registered via claude CLI -> ${mcpJs(s)}`);
    a.say(r.ok ? "  claude CLI did not register it; wrote ~/.claude.json directly" : "  claude CLI failed; falling back to editing ~/.claude.json");
  }
  const path = claudeJsonPath(s);
  const cfg = existsSync(path) ? readJson(path) : {};
  if (cfg === null) return a.fail(`${path} is not valid JSON; not touching it`);
  const next = { ...cfg, mcpServers: { ...(cfg.mcpServers ?? {}), aibroker: { type: "stdio", command: s.execPath, args: [mcpJs(s)] } } };
  a.write(path, `${JSON.stringify(next, null, 2)}\n`, true);
  a.done(`  merged aibroker into ${path} (other servers untouched, backup ${path}.bak)`);
}

function mcpRemove(a: Act): void {
  const s = a.s;
  const entry = readMcpEntry(s);
  if (!entry.found) return a.say("  no aibroker entry");
  if (entry.target !== mcpJs(s)) return a.say(`  aibroker entry points elsewhere (${entry.target ?? "?"}); left alone`);
  const claude = s.which("claude");
  if (claude && a.run(claude, ["mcp", "remove", "--scope", "user", "aibroker"]).ok) return a.done("  removed via claude CLI");
  const path = claudeJsonPath(s);
  const cfg = readJson(path);
  if (!cfg) return a.fail(`${path} unreadable; not touching it`);
  const { aibroker: _gone, ...others } = cfg.mcpServers;
  a.write(path, `${JSON.stringify({ ...cfg, mcpServers: others }, null, 2)}\n`, true);
  a.done(`  removed aibroker from ${path}`);
}

// ── hooks ─────────────────────────────────────────────────────────────────

function hooksEdit(a: Act, remove: boolean): void {
  const s = a.s;
  const path = settingsPath(s);
  const cur = existsSync(path) ? readJson(path) : {};
  if (cur === null) return a.fail(`${path} is not valid JSON; not touching it`);
  if (remove) {
    const { settings, removed } = unmergeHooks(cur, s);
    if (!removed) return a.say("  no hooks of this install found");
    a.write(path, `${JSON.stringify(settings, null, 2)}\n`, true);
    return a.done(`  removed ${removed} hook entr(ies) from ${path}`);
  }
  const { settings, added, present } = mergeHooks(cur, s);
  for (const f of present) a.say(`  already wired: ${f}`);
  if (!added.length) return;
  a.write(path, `${JSON.stringify(settings, null, 2)}\n`, true);
  for (const h of added) a.say(`  ${a.dryRun ? "would add" : "added"}: ${h}`);
}

// ── env file ──────────────────────────────────────────────────────────────

function envFile(a: Act): void {
  const path = envFilePath(a.s);
  if (existsSync(path)) return a.say(`  ${path} exists; left alone`);
  a.write(path, ENV_TEMPLATE);
  a.done(`  created ${path} (0600)`);
}

// ── entry points ──────────────────────────────────────────────────────────

/** Returns the number of failed steps. */
export function setup(s: Sys, opts: Opts, say: Say = console.log): number {
  const a = new Act(s, opts.dryRun, say);
  say(`aibroker setup${opts.dryRun ? " (dry run, nothing is written)" : ""}: ${s.platform}, ${s.pkgRoot}`);
  say("env:");
  envFile(a);
  if (opts.service) {
    say("service:");
    if (s.platform === "linux") serviceLinux(a, opts);
    else if (s.platform === "darwin") serviceMac(a, opts);
    else say(`  no service support on ${s.platform}; run: ${s.execPath} ${cliJs(s)} start`);
  }
  if (opts.mcp) { say("mcp:"); mcpAdd(a); }
  if (opts.hooks) { say("hooks:"); hooksEdit(a, false); }
  say(a.fails ? `setup finished with ${a.fails} failure(s)` : "setup done. Next: aibroker doctor");
  return a.fails;
}

export function uninstall(s: Sys, opts: Opts, say: Say = console.log): number {
  const a = new Act(s, opts.dryRun, say);
  say(`aibroker uninstall${opts.dryRun ? " (dry run, nothing is changed)" : ""}`);
  if (opts.service) {
    say("service:");
    if (s.platform === "linux") {
      if (s.which("systemctl")) a.run("systemctl", ["--user", "disable", "--now", UNIT_NAME]);
      if (existsSync(unitPath(s))) { a.remove(unitPath(s)); a.done(`  removed ${unitPath(s)}`); } else say("  no unit installed");
      if (s.which("systemctl")) a.run("systemctl", ["--user", "daemon-reload"]);
    } else if (s.platform === "darwin") {
      if (existsSync(plistPath(s))) {
        a.run("launchctl", ["bootout", `gui/${s.uid}/${PLIST_LABEL}`]);
        a.remove(plistPath(s));
        a.done(`  removed ${plistPath(s)}`);
      } else say("  no plist installed");
    }
  }
  if (opts.mcp) { say("mcp:"); mcpRemove(a); }
  if (opts.hooks) { say("hooks:"); hooksEdit(a, true); }
  const data = join(s.home, ".aibroker");
  if (opts.purge) { a.remove(data, true); a.done(`  purged ${data}`); } else say(`kept ${data} (add --purge to delete it)`);
  return a.fails;
}

const FLAGS = {
  setup: ["--no-service", "--no-mcp", "--no-hooks", "--dry-run", "--force"],
  uninstall: ["--no-service", "--no-mcp", "--no-hooks", "--dry-run", "--purge"],
};

export const usage = (cmd: keyof typeof FLAGS) => `usage: aibroker ${cmd} [${FLAGS[cmd].join("] [")}] [--help]`;

/** Help or a bad flag ends the command before anything is touched; returns the exit code, or null to proceed. */
export function checkArgs(cmd: keyof typeof FLAGS, argv: string[], say: Say = console.log): number | null {
  if (argv.includes("--help") || argv.includes("-h")) { say(usage(cmd)); return 0; }
  const bad = argv.find((a) => !FLAGS[cmd].includes(a));
  if (bad === undefined) return null;
  say(`unknown option: ${bad}`);
  say(usage(cmd));
  return 1;
}

export async function runSetup(argv: string[], s?: Sys, say: Say = console.log): Promise<void> {
  const early = checkArgs("setup", argv, say);
  process.exitCode = early ?? (setup(s ?? realSys(), parseOpts(argv), say) ? 1 : 0);
}

export async function runUninstall(argv: string[], s?: Sys, say: Say = console.log): Promise<void> {
  const early = checkArgs("uninstall", argv, say);
  process.exitCode = early ?? (uninstall(s ?? realSys(), parseOpts(argv), say) ? 1 : 0);
}
