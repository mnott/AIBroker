/**
 * daemon/ask-cli.ts — `aibroker ask <project> --stdin --timeout <secs> --json`.
 *
 * Thin client over the daemon's `ask` handler, for callers with no session and
 * no mailbox — a launchd poller asking whether the session it gave work to is
 * still alive.
 *
 * All probe outcomes exit 0, same convention as `dispatch`: "it did not answer"
 * is a result to act on, not a crash. Only a genuine failure — daemon down,
 * unreadable stdin, bad usage — exits non-zero.
 */
import { WatcherClient } from "../ipc/client.js";
import { DAEMON_SOCKET_PATH } from "./index.js";
import type { AskResult } from "./ask.js";

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf-8");
}

function usage(): void {
  console.log(`aibroker ask — put a question to a project's session and wait for its answer

  aibroker ask <project> --stdin [--timeout SECONDS] [--json]

  <project>          curated project name or alias (case-insensitive)
  --stdin            read the question from stdin
  --question TEXT    inline question, for short probes
  --timeout SECONDS  total budget (default 60)
  --json             emit a single JSON object on stdout

Never spawns a session: a probe must not create the thing it is probing for.

Outcomes (all exit 0):
  replied   the session answered; "reply" holds its words
  busy      mid-turn and still producing output. ALIVE — nothing was sent
  silent    idle, took the question, never answered. Genuinely suspicious
  absent    no live session for that project

Note: "busy" is positive evidence of life and must not count toward a stuck
threshold. Claude queues input while working, so a session mid-turn cannot
answer for as long as that turn lasts; asking anyway would report every
slow-but-healthy task as stuck. Liveness is therefore checked BEFORE any
question is sent, which also means a working session pays no token cost.`);
}

export async function runAsk(args: string[]): Promise<void> {
  const has = (f: string) => args.includes(f);
  const val = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

  if (has("--help") || has("-h") || args.length === 0) { usage(); return; }

  const flagValues = new Set(
    ["--question", "--timeout"].map((f) => val(f)).filter((v): v is string => v !== undefined),
  );
  const project = args.find((a) => !a.startsWith("--") && !flagValues.has(a));
  if (!project) {
    console.error("Usage: aibroker ask <project> --stdin [--timeout SECONDS] [--json]");
    process.exitCode = 2;
    return;
  }

  const json = has("--json");
  const question = has("--stdin") ? await readStdin() : (val("--question") ?? "");
  if (!question.trim()) {
    console.error("No question. Pass --stdin (preferred) or --question TEXT.");
    process.exitCode = 2;
    return;
  }

  const rawTimeout = val("--timeout");
  const timeoutMs = rawTimeout !== undefined ? Number(rawTimeout) * 1000 : undefined;
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
    console.error(`--timeout expects a non-negative number of seconds, got "${rawTimeout}"`);
    process.exitCode = 2;
    return;
  }

  let result: AskResult;
  try {
    const res = await new WatcherClient(DAEMON_SOCKET_PATH).call_raw("ask", {
      project,
      question,
      timeoutMs,
    });
    result = res as unknown as AskResult;
  } catch (err) {
    const reason = `Could not reach the aibroker daemon at ${DAEMON_SOCKET_PATH}: ` +
      `${err instanceof Error ? err.message : String(err)}. Is it running? (aibroker start)`;
    if (json) console.log(JSON.stringify({ replied: false, session: "", state: "error", reason }));
    else console.error(reason);
    process.exitCode = 1;
    return;
  }

  if (json) {
    // Shape matches the agreed contract; `state` is additive for callers that
    // want to distinguish busy (alive) from silent (suspicious) without
    // matching on prose.
    console.log(JSON.stringify({
      replied: result.replied,
      session: result.session,
      ...(result.reply !== undefined ? { reply: result.reply } : {}),
      ...(result.reason !== undefined ? { reason: result.reason } : {}),
      state: result.state,
    }));
    return;
  }

  if (result.replied) console.log(`${result.session}: ${result.reply}`);
  else console.log(`${result.state}${result.session ? ` (${result.session})` : ""}: ${result.reason}`);
}
