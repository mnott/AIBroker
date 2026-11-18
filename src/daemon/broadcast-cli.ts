/**
 * daemon/broadcast-cli.ts — `aibroker broadcast ...`.
 *
 *   aibroker broadcast "<text>" [--ask] [--deadline 2m] [--default-ok]
 *   aibroker broadcast reply <id> ok|hold ["<reason>"]
 *   aibroker broadcast status <id>
 *
 * A thin client over the daemon's `broadcast*` handlers: who receives, what is
 * ledgered and how a roll-call reads all live in broadcast-core.ts behind the
 * hub, so the shell flow and the MCP tools cannot drift apart. The sender's
 * identity rides with the request (iTerm/tmux env, as every hub call carries).
 *
 * Text comes from the arguments, or from stdin when there are none — same rule
 * as `aibroker send`: argv mangles multi-line bodies.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WatcherClient } from "../ipc/client.js";
import { DAEMON_SOCKET_PATH } from "./index.js";
import type { BroadcastRecord, BroadcastStatusRow } from "./broadcast-core.js";
import { statusRows } from "./broadcast-core.js";
import { stateDir } from "./owner-rename.js";

function usage(): string {
  return [
    "Usage: aibroker broadcast \"<text>\" [--ask] [--deadline <2m|90s|1h>] [--default-ok]",
    "       echo \"<text>\" | aibroker broadcast [--ask ...]",
    "       aibroker broadcast reply <id> ok|hold [\"<short reason>\"]",
    "       aibroker broadcast status <id>",
    "",
    "--ask       the message carries a broadcast id and asks for a short answer;",
    "            recipients reply with `aibroker broadcast reply <id> ok|hold \"reason\"`.",
    "--deadline  how long to wait for answers (default 5m); an ask without an",
    "            answer by then is 'pending' until it passes, then silent.",
    "--default-ok  after the deadline, silence counts as \"no objection\" instead",
    "            of \"silent\". Only this flag turns quiet into agreement.",
  ].join("\n");
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf-8");
}

function fmtRows(rows: Array<{ name: string; status: string; reason?: string }>): string {
  return rows.map((r) => `  ${r.status.padEnd(12)} ${r.name}${r.reason ? ` — ${r.reason}` : ""}`).join("\n");
}

function fmtDeadline(deadlineAt?: number, deadlinePassed?: boolean): string {
  if (deadlineAt === undefined) return "";
  return `\ndeadline ${new Date(deadlineAt).toISOString()}${deadlinePassed ? " (passed)" : ""}`;
}

/**
 * The ledger read straight from disk — the same file the daemon writes.
 *
 * `broadcast status` must answer even when the daemon call fails or is
 * answered by a build too old to know the roll-call method (the 2026-11-18
 * incident: the shout delivered fine, yet `status d4zy5` read "not found"
 * while the ledger held every reply). The file is the durable source of truth;
 * the daemon is just a faster path to it. A missing or unreadable file is no
 * answer — return null and let the daemon's error stand.
 */
function rollcallFromLedger(id: string): { senderName: string; message: string; ask: boolean; defaultOk: boolean; deadlineAt?: number; deadlinePassed: boolean; rows: BroadcastStatusRow[] } | null {
  try {
    const path = join(stateDir(), "broadcasts.json");
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, "utf-8")) as Record<string, BroadcastRecord>;
    const b = data[id];
    if (!b) return null;
    const now = Date.now();
    return {
      senderName: b.senderName, message: b.message, ask: b.ask, defaultOk: b.defaultOk,
      ...(b.deadlineAt !== undefined ? { deadlineAt: b.deadlineAt } : {}),
      deadlinePassed: b.deadlineAt !== undefined && now >= b.deadlineAt,
      rows: statusRows(b, now),
    };
  } catch { return null; }
}

function fmtCounts(s: { ask: boolean; defaultOk: boolean; rows: BroadcastStatusRow[] }): string {
  const counts = new Map<string, number>();
  for (const row of s.rows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  return [...counts].map(([k, n]) => `${n} ${k}`).join(", ") + (s.defaultOk ? " (silence defaults to no objection)" : "");
}

/** Returns the process exit code. */
export async function broadcast(args: string[], deps: {
  call: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  readStdin: () => Promise<string>;
  out: (line: string) => void;
}): Promise<number> {
  const [verb, ...rest] = args;

  if (verb === "reply") {
    const [id, answer, ...reasonWords] = rest;
    if (!id || !["ok", "hold"].includes(answer ?? "")) {
      deps.out("Usage: aibroker broadcast reply <id> ok|hold [\"<short reason>\"]");
      return 1;
    }
    const reason = reasonWords.join(" ").trim() || undefined;
    let r: Record<string, unknown>;
    try {
      r = await deps.call("broadcast_reply", { broadcastId: id, answer, ...(reason ? { reason } : {}) });
    } catch (err) {
      console.error(`broadcast reply failed: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    deps.out(`Answered ${answer} on broadcast ${id}.`);
    return 0;
  }

  if (verb === "status") {
    const id = rest[0];
    if (!id) { deps.out("Usage: aibroker broadcast status <id>"); return 1; }
    // The daemon first (it also fires the summary), the ledger file as the
    // fallback — the roll-call is durable on disk by design, so an old or
    // unreachable daemon must not make a known broadcast read "not found".
    type Rollcall = { senderName: string; message: string; ask: boolean; defaultOk: boolean; deadlineAt?: number; deadlinePassed?: boolean; rows: BroadcastStatusRow[] };
    let s: Rollcall | null = null;
    let daemonError = "";
    try {
      const r = await deps.call("broadcast_rollcall", { broadcastId: id });
      // A reply without rows is not a roll-call — treat it like no answer.
      if (Array.isArray((r as { rows?: unknown }).rows)) s = r as unknown as Rollcall;
      else daemonError = "the daemon answered the roll-call without any rows";
    } catch (err) {
      daemonError = err instanceof Error ? err.message : String(err);
    }
    if (!s) s = rollcallFromLedger(id);
    if (!s) { console.error(`broadcast status failed: ${daemonError || `no broadcast with id "${id}"`}`); return 1; }
    deps.out(`broadcast ${id} from ${s.senderName}: ${s.message}${fmtDeadline(s.deadlineAt, s.deadlinePassed)}`);
    if (s.ask) deps.out(fmtCounts(s));
    deps.out(fmtRows(s.rows));
    return 0;
  }

  // The shout itself: flags first, then the text (argv or stdin).
  let ask = false;
  let defaultOk = false;
  let deadline: string | undefined;
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--ask") ask = true;
    else if (a === "--default-ok") defaultOk = true;
    else if (a === "--deadline") deadline = args[++i];
    else if (a.startsWith("--")) { console.error(`unknown flag: ${a}\n${usage()}`); return 1; }
    else words.push(a);
  }
  const message = words.length ? words.join(" ") : (await deps.readStdin()).replace(/\n+$/, "");
  if (!message) { console.error(`Nothing to broadcast.\n${usage()}`); return 1; }

  // `call` resolves ONLY when the daemon accepted the call — a refusal arrives
  // as a thrown error carrying its reason (see ipc/client.ts). Nothing here
  // re-reads an `ok` field: that misread is what made a delivered broadcast
  // print "refused" (2026-11-18) while every recipient had already answered.
  let r: Record<string, unknown>;
  try {
    r = await deps.call("broadcast", { message, ask, defaultOk, ...(deadline !== undefined ? { deadline } : {}) });
  } catch (err) {
    console.error(`broadcast refused: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const sent = r as { id?: string; deliveredTo?: number; skippedShells?: number; recipients?: Array<{ sessionId: string; name: string }> };
  if (!sent.id) { console.error("broadcast refused: the daemon accepted the call but named no broadcast id — nothing was reported as sent"); return 1; }
  const delivered = Number(sent.deliveredTo ?? 0);
  deps.out(`Broadcast ${sent.id} delivered to ${delivered} session(s)${sent.skippedShells ? `, ${sent.skippedShells} shell tab(s) skipped` : ""}.`);
  for (const rec of sent.recipients ?? []) deps.out(`  → ${rec.name}`);
  if (ask) {
    deps.out(`Answers asked${deadline ? `, deadline ${deadline}` : ""}. Collect them with: aibroker broadcast status ${sent.id}`);
  }
  return 0;
}

export async function runBroadcast(args: string[]): Promise<void> {
  const code = await broadcast(args, {
    call: (method, params) => new WatcherClient(DAEMON_SOCKET_PATH).call_raw(method, params) as Promise<Record<string, unknown>>,
    readStdin,
    out: (l) => console.log(l),
  });
  if (code !== 0) process.exit(code);
}
