/**
 * daemon/dispatch-cli.ts — `aibroker dispatch <project> [--stdin] [--json] [--no-spawn]`.
 *
 * A thin client over the daemon's `dispatch` handler. The logic lives in the
 * daemon so MCP, PAILot and adapters can route work without shelling out; this
 * exists because a CLI subcommand is a stable, versioned, language-agnostic
 * boundary, and callers probe for it to detect support.
 *
 * Routing outcomes exit 0. Only a genuine failure — daemon down, unreadable
 * stdin, bad usage — exits non-zero, so a batch keeps going when one task
 * can't be routed.
 */
import { WatcherClient } from "../ipc/client.js";
import { DAEMON_SOCKET_PATH } from "./index.js";
import type { DispatchResult } from "./dispatch.js";

/**
 * Read the whole of stdin.
 *
 * Task bodies are multi-line and carry backticks, quotes and newlines, which is
 * exactly what argv mangles — hence stdin rather than an argument.
 */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf-8");
}

function usage(): void {
  console.log(`aibroker dispatch — deliver a work order to a project's session

  aibroker dispatch <project> --stdin [--json] [--no-spawn] [--timeout SECONDS]

  <project>            curated project name or alias (case-insensitive)
  --stdin              read the message body from stdin (recommended: argv
                       mangles multi-line bodies with quotes and backticks)
  --message TEXT       inline body, for short one-liners
  --json               emit a single JSON object on stdout
  --no-spawn           never launch a session; report "skipped" instead
  --timeout SECONDS    TOTAL budget for the whole dispatch — spawn wait and
                       delivery share it, so it is a real upper bound. Set it
                       below your own kill timer and you always get a reason
                       back instead of a killed process.

Outcomes (all exit 0 — they are results, not failures):
  delivered      a live session accepted it
  spawned        no session ran; one was launched and accepted it
  unlaunchable   no curated alias — run \`pai project name <id> <shortname>\`
  unreachable    tab opened but the session never accepted input
  skipped        no live session and --no-spawn was set`);
}

export async function runDispatch(args: string[]): Promise<void> {
  const has = (f: string) => args.includes(f);
  const val = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

  if (has("--help") || has("-h") || args.length === 0) { usage(); return; }

  // The project is the first bare token that isn't a flag's value.
  const flagValues = new Set(
    ["--message", "--timeout"].map((f) => val(f)).filter((v): v is string => v !== undefined),
  );
  const project = args.find((a) => !a.startsWith("--") && !flagValues.has(a));
  if (!project) {
    console.error("Usage: aibroker dispatch <project> --stdin [--json] [--no-spawn]");
    process.exitCode = 2;
    return;
  }

  const json = has("--json");
  const message = has("--stdin") ? await readStdin() : (val("--message") ?? "");
  if (!message.trim()) {
    console.error("No message body. Pass --stdin (preferred) or --message TEXT.");
    process.exitCode = 2;
    return;
  }

  // A TOTAL budget for the whole dispatch, not a per-stage cap. Callers wrap
  // this process in their own kill timer; if our stages each held a separate
  // limit they would sum past the caller's, and the caller would kill us before
  // our own deadline fired — surfacing as its timeout, with our reason lost.
  const timeout = val("--timeout");
  const budgetMs = timeout !== undefined ? Number(timeout) * 1000 : undefined;
  if (budgetMs !== undefined && (!Number.isFinite(budgetMs) || budgetMs < 0)) {
    console.error(`--timeout expects a non-negative number of seconds, got "${timeout}"`);
    process.exitCode = 2;
    return;
  }

  let result: DispatchResult;
  try {
    const res = await new WatcherClient(DAEMON_SOCKET_PATH).call_raw("dispatch", {
      project,
      message,
      noSpawn: has("--no-spawn"),
      budgetMs,
    });
    result = res as unknown as DispatchResult;
  } catch (err) {
    // The daemon being down IS a real failure — distinct from a routing outcome.
    const reason = `Could not reach the aibroker daemon at ${DAEMON_SOCKET_PATH}: ` +
      `${err instanceof Error ? err.message : String(err)}. Is it running? (aibroker start)`;
    if (json) console.log(JSON.stringify({ outcome: "error", project, session: "", reason }));
    else console.error(reason);
    process.exitCode = 1;
    return;
  }

  if (json) {
    console.log(JSON.stringify({
      outcome: result.outcome,
      project: result.project,
      session: result.session,
      reason: result.reason,
    }));
    return;
  }

  const line = result.session
    ? `${result.outcome}: ${result.project} → ${result.session}`
    : `${result.outcome}: ${result.project}`;
  console.log(result.reason ? `${line}\n  ${result.reason}` : line);
}
