/**
 * daemon/doctor.ts — `aibroker doctor`: one line per check, ok / warn / FAIL,
 * every non-ok line names the fix. Exit non-zero only on FAIL (a required
 * check); warn marks something optional or not yet started.
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { transportPolicy } from "../transport/policy.js";
import { WatcherClient } from "../ipc/client.js";
import { DAEMON_SOCKET_PATH } from "./index.js";
import {
  HOOK_PLAN, PLIST_LABEL, UNIT_NAME, daemonLogPath, envFilePath, plistPath, readMcpEntry, realSys, settingsPath, unitPath, type Sys,
} from "./setup.js";
import { readFileSync } from "node:fs";

export type Level = "ok" | "warn" | "FAIL";
export interface Check { level: Level; name: string; detail: string; fix?: string }

export interface Probes {
  /** Does the daemon answer `ping` on its socket? */
  ping(): Promise<boolean>;
}

export const realProbes: Probes = {
  ping: async () => {
    try { await new WatcherClient(DAEMON_SOCKET_PATH).call_raw("ping", {}); return true; } catch { return false; }
  },
};

const mode = (p: string) => statSync(p).mode & 0o777;

export async function diagnose(s: Sys, probes: Probes): Promise<Check[]> {
  const out: Check[] = [];
  const add = (level: Level, name: string, detail: string, fix?: string) => out.push({ level, name, detail, fix });

  const major = Number(s.nodeVersion.replace(/^v/, "").split(".")[0]);
  if (major >= 22) add("ok", "node", s.nodeVersion);
  else add("FAIL", "node", `${s.nodeVersion} (need >=22)`, "install Node.js 22 or newer");

  const policy = transportPolicy(s.env, s.platform);
  add("ok", "transport", `${s.platform}: ${[policy.allowTmux && "tmux", policy.allowIterm && "iterm"].filter(Boolean).join("+")}`);

  const tmux = s.which("tmux");
  if (!tmux) {
    add(policy.allowTmux ? "FAIL" : "warn", "tmux", "not installed", "install it: apt install tmux | dnf install tmux | pacman -S tmux | brew install tmux");
  } else {
    const v = s.run(tmux, ["-V"]);
    add("ok", "tmux", v.out.trim() || tmux);
    if (s.run(tmux, ["list-sessions"]).ok) add("ok", "tmux server", `reachable as ${s.user}`);
    else add("warn", "tmux server", `no server reachable as ${s.user}`, "start one as this user: tmux new -s work");
  }

  if (s.which("ffmpeg")) add("ok", "ffmpeg", "found");
  else add("warn", "ffmpeg", "missing (voice conversion off)", "install it: apt install ffmpeg | dnf install ffmpeg | pacman -S ffmpeg | brew install ffmpeg");
  for (const [bin, what] of [["whisper", "speech to text"], ["sox", "local dictation"]] as const) {
    add(s.which(bin) ? "ok" : "warn", bin, s.which(bin) ? "found" : `missing (optional, ${what})`);
  }
  const player = ["afplay", "paplay", "aplay", "ffplay"].find((p) => s.which(p));
  add(player ? "ok" : "warn", "audio player", player ?? "none of afplay/paplay/aplay/ffplay (optional)");

  serviceChecks(s, add);

  if (await probes.ping()) add("ok", "daemon socket", `answers ping on ${DAEMON_SOCKET_PATH}`);
  else add("FAIL", "daemon socket", `no answer on ${DAEMON_SOCKET_PATH}`, "aibroker setup, or aibroker start, then check the service log");

  const mcp = readMcpEntry(s);
  if (!mcp.found) add("FAIL", "mcp entry", "no aibroker server in ~/.claude.json", "aibroker setup");
  else if (!mcp.target || !existsSync(mcp.target)) add("FAIL", "mcp entry", `points at a missing file (${mcp.target ?? "no .js argument"})`, "aibroker setup");
  else add("ok", "mcp entry", mcp.target);

  hookChecks(s, add);

  const env = envFilePath(s);
  if (!existsSync(env)) add("warn", "env file", `${env} missing`, "aibroker setup");
  else if (mode(env) & 0o077) add("FAIL", "env file", `mode ${mode(env).toString(8)} (holds secrets)`, `chmod 600 ${env}`);
  else add("ok", "env file", "0600");

  for (const f of [join(s.home, ".aibroker", "audit.jsonl"), daemonLogPath(s)]) {
    if (!existsSync(f)) continue;
    if (mode(f) & 0o077) add("FAIL", "file mode", `${f} is ${mode(f).toString(8)}`, `chmod 600 ${f}`);
    else add("ok", "file mode", `${f} 0600`);
  }
  return out;
}

function serviceChecks(s: Sys, add: (l: Level, n: string, d: string, f?: string) => void): void {
  if (s.platform === "linux") {
    if (!existsSync(unitPath(s))) return add("FAIL", "service", `${unitPath(s)} missing`, "aibroker setup");
    if (!s.which("systemctl")) return add("warn", "service", "unit present but systemctl not found", "run the daemon under your own supervisor");
    const active = s.run("systemctl", ["--user", "is-active", UNIT_NAME]);
    if (active.out.trim() === "active") add("ok", "service", `${UNIT_NAME} active`);
    else add("FAIL", "service", `${UNIT_NAME} ${active.out.trim() || "not active"}`, `systemctl --user enable --now ${UNIT_NAME}; journalctl --user -u aibroker -n 50`);
    if (s.which("loginctl")) {
      if (/Linger=yes/.test(s.run("loginctl", ["show-user", s.user, "-p", "Linger"]).out)) add("ok", "linger", "on");
      else add("warn", "linger", "off: the service stops at logout", `sudo loginctl enable-linger ${s.user}`);
    }
  } else if (s.platform === "darwin") {
    if (!existsSync(plistPath(s))) return add("FAIL", "service", `${plistPath(s)} missing`, "aibroker setup");
    if (s.run("launchctl", ["print", `gui/${s.uid}/${PLIST_LABEL}`]).ok) add("ok", "service", `${PLIST_LABEL} loaded`);
    else add("FAIL", "service", `${PLIST_LABEL} not loaded`, `launchctl bootstrap gui/${s.uid} ${plistPath(s)}`);
  }
}

function hookChecks(s: Sys, add: (l: Level, n: string, d: string, f?: string) => void): void {
  let settings: Record<string, any> = {};
  try { settings = JSON.parse(readFileSync(settingsPath(s), "utf8")); } catch { /* none or unreadable: every hook reads as missing */ }
  const missing = HOOK_PLAN.filter((h) =>
    !((settings.hooks?.[h.event] ?? []) as { hooks?: { command?: string }[] }[])
      .some((g) => (g.hooks ?? []).some((x) => (x.command ?? "").includes(`/hooks/${h.file}`))));
  if (!missing.length) add("ok", "hooks", `${HOOK_PLAN.length} wired in ${settingsPath(s)}`);
  else add("FAIL", "hooks", `missing: ${missing.map((h) => h.file).join(", ")}`, "aibroker setup");
}

export async function runDoctor(_argv: string[], s: Sys = realSys(), probes: Probes = realProbes, say: (l: string) => void = console.log): Promise<void> {
  const checks = await diagnose(s, probes);
  for (const c of checks) say(`  ${c.level.padEnd(4)}  ${c.name.padEnd(13)} ${c.detail}${c.fix && c.level !== "ok" ? `\n        fix: ${c.fix}` : ""}`);
  const failed = checks.filter((c) => c.level === "FAIL").length;
  say(failed ? `${failed} required check(s) failed` : "all required checks pass");
  process.exitCode = failed ? 1 : 0;
}
