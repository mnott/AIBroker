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
import { WatcherClient } from "../ipc/client.js";
import { DAEMON_SOCKET_PATH } from "./index.js";

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
    if (!r.ok) { console.error(String(r.error ?? "refused")); return 1; }
    deps.out(`Answered ${answer} on broadcast ${id}.`);
    return 0;
  }

  if (verb === "status") {
    const id = rest[0];
    if (!id) { deps.out("Usage: aibroker broadcast status <id>"); return 1; }
    let r: Record<string, unknown>;
    try {
      r = await deps.call("broadcast_rollcall", { broadcastId: id });
    } catch (err) {
      console.error(`broadcast status failed: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
    if (!r.ok) { console.error(String(r.error ?? "not found")); return 1; }
    const s = r as { id: string; senderName: string; message: string; ask: boolean; defaultOk: boolean; deadlinePassed?: boolean; rows: Array<{ name: string; status: string; reason?: string }> };
    deps.out(`broadcast ${s.id} from ${s.senderName}: ${s.message}`);
    if (s.ask) {
      const counts = new Map<string, number>();
      for (const row of s.rows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
      deps.out([...counts].map(([k, n]) => `${n} ${k}`).join(", ") + (s.defaultOk ? " (silence defaults to no objection)" : ""));
    }
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

  let r: Record<string, unknown>;
  try {
    r = await deps.call("broadcast", { message, ask, defaultOk, ...(deadline !== undefined ? { deadline } : {}) });
  } catch (err) {
    console.error(`broadcast failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  if (!r.ok) { console.error(String(r.error ?? "refused")); return 1; }
  const sent = r as { id: string; deliveredTo: number; skippedShells: number; ask?: boolean };
  deps.out(`Broadcast ${sent.id} to ${sent.deliveredTo} session(s)${sent.skippedShells ? `, ${sent.skippedShells} shell tab(s) skipped` : ""}.`);
  if (ask) deps.out("Answers asked. Collect them with: aibroker broadcast status " + sent.id);
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
