/**
 * daemon/a2a-cli.ts — `aibroker a2a`, from a shell rather than an MCP tool.
 *
 * Two families of verb. `card`, `send`, `get`, `cancel`, `check` are pure
 * A2A CLIENT operations — they speak to ANY A2A v0.3.0 agent over the
 * network and need no daemon running locally; `check` in particular is
 * generic interoperability tooling, not a self-test, and is meant to be
 * pointed at agents this project did not write.
 *
 * `expose`, `unexpose`, `exposed`, `tasks`, `setup` operate on THIS
 * machine's A2A server: which sessions it publishes as skills, what
 * tasks are on file, and how the endpoint is exposed to the internet.
 * `reply` goes through the daemon (`WatcherClient`), the same reason
 * `aibroker issue` does — the calling session's identity and the audit
 * record both live there, and a CLI that mutated the task file directly
 * would bypass both.
 */

import { randomBytes } from "node:crypto";
import { existsSync, appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";
import { loadEnvFile } from "../core/env.js";
import { WatcherClient } from "../ipc/client.js";
import { DAEMON_SOCKET_PATH } from "./index.js";
import { fetchAgentCard, sendMessage, getTask, cancelTask, pollUntilDone } from "../a2a/client.js";
import { expose, unexpose, listExposed } from "../a2a/exposure.js";
import { listAll, listForSession } from "../a2a/tasks.js";
import { funnelHostname } from "./funnel-watchdog.js";

function usage(): void {
  console.log("Usage: aibroker a2a <verb> [options]");
  console.log("");
  console.log("Client — task any A2A v0.3.0 agent:");
  console.log("  card <url>                        Fetch and print an AgentCard");
  console.log("  send <url> --skill s [--ag2] [--context id] --token T --body -");
  console.log("  get <url> <taskId> [--token T]");
  console.log("  cancel <url> <taskId> [--token T]");
  console.log("  check <url> [--skill s] [--token T]");
  console.log("                                     Interop smoke test: card, hello send, poll to done");
  console.log("");
  console.log("This server — which sessions this machine offers, and its own tasks:");
  console.log("  expose <session> [--as \"description\"]   Publish a session as an A2A skill");
  console.log("  unexpose <session>                       Stop publishing it");
  console.log("  exposed                                  List what is published now");
  console.log("  tasks [--session name]                   Local tasks and their state");
  console.log("  reply <taskId> --body -                  Reply to a task addressed to your session");
  console.log("  setup [--print-only]                     Generate a token, expose the endpoint, verify it");
  console.log("");
  console.log("`--body -` reads from stdin. See docs/a2a.md.");
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
function hasFlag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

/** AIBROKER_A2A_URL wins whole; otherwise https://<public host>/a2a. Exported for tests. */
export function resolveOwnA2AUrl(): string {
  if (process.env.AIBROKER_A2A_URL) return process.env.AIBROKER_A2A_URL.replace(/\/+$/, "");
  const host = process.env.AIBROKER_PUBLIC_HOST ?? funnelHostname().hostname;
  if (!host) throw new Error("no public host: set AIBROKER_A2A_URL or AIBROKER_PUBLIC_HOST, or bring the Tailscale funnel up");
  return `https://${host}/a2a`;
}

function printCard(card: unknown): void {
  console.log(JSON.stringify(card, null, 2));
}

async function runCard(args: string[]): Promise<void> {
  let url = args[1];
  if (!url) {
    try { url = resolveOwnA2AUrl().replace(/\/a2a$/, ""); }
    catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 2; return; }
  }
  const r = await fetchAgentCard(url);
  if (!r.ok) { console.error(`INVALID: ${r.errors.join("; ")}`); process.exitCode = 1; return; }
  printCard(r.card);
}

async function runSend(args: string[]): Promise<void> {
  const url = args[1];
  if (!url) { console.error("Usage: aibroker a2a send <url> --skill s [--ag2] --body -"); process.exitCode = 2; return; }
  let body = flag(args, "body");
  if (body === "-") body = await readStdin();
  if (!body?.trim()) { console.error("--body is required (use --body - for stdin)"); process.exitCode = 2; return; }
  const r = await sendMessage(url, {
    skillId: flag(args, "skill"),
    text: body,
    ag2: hasFlag(args, "ag2"),
    contextId: flag(args, "context"),
    token: flag(args, "token") ?? process.env.AIBROKER_A2A_TOKEN,
  });
  if (!r.ok) { console.error(r.error); process.exitCode = 1; return; }
  printCard(r.task);
}

async function runGetOrCancel(args: string[], cancel: boolean): Promise<void> {
  const [, url, taskId] = args;
  if (!url || !taskId) { console.error(`Usage: aibroker a2a ${cancel ? "cancel" : "get"} <url> <taskId>`); process.exitCode = 2; return; }
  const token = flag(args, "token") ?? process.env.AIBROKER_A2A_TOKEN;
  const r = cancel ? await cancelTask(url, taskId, token) : await getTask(url, taskId, token);
  if (!r.ok) { console.error(r.error); process.exitCode = 1; return; }
  printCard(r.task);
}

async function runCheck(args: string[]): Promise<void> {
  const url = args[1];
  if (!url) { console.error("Usage: aibroker a2a check <url>"); process.exitCode = 2; return; }
  const token = flag(args, "token") ?? process.env.AIBROKER_A2A_TOKEN;
  const rows: { step: string; pass: boolean; detail: string }[] = [];

  const card = await fetchAgentCard(url);
  rows.push({ step: "fetch + validate AgentCard", pass: card.ok, detail: card.ok ? card.card!.name : card.errors.join("; ") });

  if (card.ok) {
    const skillId = flag(args, "skill") ?? card.card!.skills[0]?.id;
    const a2aUrl = card.card!.url;
    const sent = await sendMessage(a2aUrl, { skillId, text: "hello from `aibroker a2a check`", token });
    rows.push({ step: "message/send", pass: sent.ok, detail: sent.ok ? `task ${sent.task!.id} (${sent.task!.status.state})` : sent.error! });

    if (sent.ok) {
      const done = await pollUntilDone(a2aUrl, sent.task!.id, { timeoutMs: 20_000, token });
      rows.push({
        step: "tasks/get → terminal state",
        pass: done.ok && done.task !== undefined,
        detail: done.task ? done.task.status.state : done.error ?? "unknown",
      });
    }
  }

  for (const r of rows) console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.step.padEnd(28)} ${r.detail}`);
  process.exitCode = rows.every((r) => r.pass) ? 0 : 1;
}

function runExpose(args: string[]): void {
  const name = args[1];
  if (!name) { console.error('Usage: aibroker a2a expose <session> [--as "description"]'); process.exitCode = 2; return; }
  const e = expose(name, flag(args, "as"));
  console.log(`${e.name} is now exposed as an A2A skill.${e.description ? ` "${e.description}"` : ""}`);
}

function runUnexpose(args: string[]): void {
  const name = args[1];
  if (!name) { console.error("Usage: aibroker a2a unexpose <session>"); process.exitCode = 2; return; }
  console.log(unexpose(name) ? `${name} is no longer exposed.` : `${name} was not exposed.`);
}

function runExposed(): void {
  const list = listExposed();
  if (list.length === 0) {
    console.log("Nothing exposed. The AgentCard currently lists no skills.");
    console.log('Expose a session with: aibroker a2a expose <session> [--as "description"]');
    return;
  }
  for (const e of list) console.log(`  ${e.name}${e.description ? ` — ${e.description}` : ""}`);
}

function runTasks(args: string[]): void {
  const session = flag(args, "session");
  const tasks = session ? listForSession(session) : listAll();
  if (tasks.length === 0) { console.log(session ? `No tasks for ${session}.` : "No tasks."); return; }
  for (const t of tasks) {
    const age = Math.round((Date.now() - Date.parse(t.updatedAt)) / 60000);
    console.log(`  ${t.id}  ${t.state.padEnd(14)} ${t.session}  updated ${age}m ago`);
  }
}

async function runReply(args: string[]): Promise<void> {
  const taskId = args[1];
  if (!taskId) { console.error("Usage: aibroker a2a reply <taskId> --body -"); process.exitCode = 2; return; }
  let body = flag(args, "body");
  if (body === "-") body = await readStdin();
  if (!body?.trim()) { console.error("--body is required (use --body - for stdin)"); process.exitCode = 2; return; }

  try {
    const res = (await new WatcherClient(DAEMON_SOCKET_PATH).call_raw("a2a_reply", { taskId, text: body })) as
      { state?: string; agentishOk?: boolean };
    console.log(`Task ${taskId} → ${res.state ?? "updated"}${res.agentishOk === false ? " (AG2 in the reply did not validate)" : ""}`);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    console.error(why.includes("ENOENT") || why.includes("connect")
      ? `Could not reach the daemon at ${DAEMON_SOCKET_PATH}. Is it running? (aibroker start)`
      : why);
    process.exitCode = 1;
  }
}

function appendEnvVar(file: string, key: string, value: string): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${existsSync(file) ? "\n" : ""}${key}=${value}\n`, "utf-8");
}

function hasTailscale(): boolean {
  try { execSync("which tailscale", { stdio: "ignore" }); return true; } catch { return false; }
}

export interface EnsureTokenResult {
  token: string;
  /** False when a token was already set — nothing was generated or written. */
  generated: boolean;
}

/**
 * `AIBROKER_A2A_TOKEN` if already set; otherwise a fresh 32-byte token,
 * written to `envFile` unless `printOnly`. Never overwrites an existing
 * token — mirrors inbound.ts's secret handling: generated once, shown once.
 * Pulled out of `runSetup` so the generate-once / keep-existing behaviour
 * is testable without touching a real `tailscale` binary or the network.
 */
export function ensureA2AToken(envFile: string, printOnly: boolean): EnsureTokenResult {
  const existing = process.env.AIBROKER_A2A_TOKEN;
  if (existing) return { token: existing, generated: false };
  const token = randomBytes(32).toString("base64url");
  if (!printOnly) {
    appendEnvVar(envFile, "AIBROKER_A2A_TOKEN", token);
    process.env.AIBROKER_A2A_TOKEN = token;
  }
  return { token, generated: true };
}

export interface VerifyResult {
  ok: boolean;
  detail: string;
  skillCount?: number;
}

/**
 * Fetch `<publicBase>/.well-known/agent-card.json` and report what came
 * back. Pulled out of `runSetup` so `setup`'s pass/fail reporting is
 * testable against an arbitrary URL, without going through DNS, Tailscale,
 * or this machine's own configured public host.
 */
export async function verifyPublicCard(publicBase: string, timeoutMs = 10_000): Promise<VerifyResult> {
  try {
    const res = await fetch(`${publicBase}/.well-known/agent-card.json`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const card = await res.json() as { name?: string; url?: string; skills?: unknown[] };
    return { ok: true, detail: `${card.name ?? "?"} at ${card.url ?? "?"}`, skillCount: card.skills?.length ?? 0 };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

async function runSetup(args: string[]): Promise<void> {
  loadEnvFile();
  const printOnly = hasFlag(args, "print-only");
  const port = Number(process.env.AIBROKER_A2A_PORT ?? process.env.TODOIST_WEBHOOK_PORT ?? 8766);
  const envFile = join(homedir(), ".aibroker", "env");

  const { token, generated } = ensureA2AToken(envFile, printOnly);
  if (generated) {
    console.log(printOnly
      ? "Would generate AIBROKER_A2A_TOKEN and save it to ~/.aibroker/env (not written: --print-only)."
      : `Generated AIBROKER_A2A_TOKEN and saved it to ~/.aibroker/env. This is the only time it is shown:\n  ${token}`);
  } else {
    console.log("AIBROKER_A2A_TOKEN is already set — leaving it alone.");
  }

  const cmds = [
    `tailscale funnel --bg --set-path=/a2a http://127.0.0.1:${port}/a2a`,
    `tailscale funnel --bg --set-path=/.well-known http://127.0.0.1:${port}/.well-known`,
  ];

  if (hasTailscale()) {
    if (printOnly) {
      console.log("\nWould run:");
      for (const c of cmds) console.log(`  ${c}`);
    } else {
      for (const c of cmds) {
        console.log(`\n+ ${c}`);
        try { execSync(c, { stdio: "inherit" }); }
        catch (e) { console.warn(`tailscale funnel may already be configured: ${e instanceof Error ? e.message : String(e)}`); }
      }
    }
  } else {
    console.log("\nTailscale not found. Put these two paths behind your own reverse proxy instead — e.g. nginx:");
    console.log(`  location /a2a { proxy_pass http://127.0.0.1:${port}/a2a; }`);
    console.log(`  location /.well-known { proxy_pass http://127.0.0.1:${port}/.well-known; }`);
    console.log("or Caddy:");
    console.log(`  agent.example.org {`);
    console.log(`    reverse_proxy /a2a* 127.0.0.1:${port}`);
    console.log(`    reverse_proxy /.well-known* 127.0.0.1:${port}`);
    console.log(`  }`);
  }

  console.log("\nThe daemon reads AIBROKER_A2A_TOKEN at startup — restart it to pick this up:");
  console.log("  aibroker stop && aibroker start");

  if (printOnly) return;

  let publicBase: string;
  try {
    publicBase = resolveOwnA2AUrl().replace(/\/a2a$/, "");
  } catch (e) {
    console.error(`\nCannot verify yet: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
    return;
  }

  console.log(`\nVerifying ${publicBase}/.well-known/agent-card.json ...`);
  const v = await verifyPublicCard(publicBase);
  if (v.ok) {
    console.log(`OK — ${v.detail}, ${v.skillCount ?? 0} skill(s) exposed.`);
    if (!v.skillCount) console.log(`Nothing exposed yet: aibroker a2a expose <session>`);
  } else {
    console.error(`FAILED: ${v.detail}`);
    console.error("The daemon may need restarting for the new token to take effect, or the funnel path is not live yet.");
    process.exitCode = 1;
  }
}

export async function runA2A(args: string[]): Promise<void> {
  const [verb] = args;
  switch (verb) {
    case undefined: case "help": case "--help": case "-h": usage(); return;
    case "card": return runCard(args);
    case "send": return runSend(args);
    case "get": return runGetOrCancel(args, false);
    case "cancel": return runGetOrCancel(args, true);
    case "check": return runCheck(args);
    case "expose": return runExpose(args);
    case "unexpose": return runUnexpose(args);
    case "exposed": return runExposed();
    case "tasks": return runTasks(args);
    case "reply": return runReply(args);
    case "setup": return runSetup(args);
    default:
      console.error(`Unknown a2a verb: ${verb}`);
      usage();
      process.exitCode = 2;
  }
}
