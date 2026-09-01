/**
 * daemon/issue-cli.ts — `aibroker issue`, the same verbs without an MCP reload.
 *
 * The MCP tool and this are the same handler; only the way in differs. That
 * matters for one reason: a new MCP tool does not appear in a session that is
 * already running, and making it appear needs a person at the keyboard. On the
 * afternoon this was written a session had a finding ready to post, the tool
 * had been published, and it could do nothing for want of a `/mcp` — while a
 * shell was sitting right there. A capability that waits on a human to become
 * reachable is not reachable.
 *
 * It goes through the daemon rather than calling the forge here, and that is
 * not ceremony. The permission check and the record of what was just written
 * both live in the daemon's memory; a CLI that talked to the forge directly
 * would bypass the first and be invisible to the second, so a session's own
 * comment would come back to it as news. The identity that decides permission
 * travels the same way it always does — the client reads `ITERM_SESSION_ID`
 * from the environment it was launched in, so running this in a pane is asking
 * as that pane, and there is no flag to claim otherwise.
 */

import { WatcherClient } from "../ipc/client.js";
import { DAEMON_SOCKET_PATH } from "./index.js";
import { loadEnvFile } from "../core/env.js";

function usage(): void {
  console.log("Usage: aibroker issue <repo-url> <verb> [options]");
  console.log("");
  console.log("Read:");
  console.log("  list                     Open issues; --state closed|all");
  console.log("  get --issue N            One issue: title, body, state, labels, assignees");
  console.log("  comments --issue N       The thread; --count N for the newest N");
  console.log("  labels                   The label names this repository has");
  console.log("  assets --issue N         Attachments");
  console.log("");
  console.log("Write:");
  console.log("  new --title T --body B   Open an issue");
  console.log("  comment --issue N --body B");
  console.log("  rewrite --issue N --body B      retitle --issue N --title T");
  console.log("  label|unlabel --issue N --label L");
  console.log("  claim|release --issue N");
  console.log("  close --issue N          Only issues this credential opened");
  console.log("");
  console.log("  --body -                 Read the body from stdin (use this for long text)");
  console.log("  --json                   Print the raw result");
  console.log("");
  console.log("You may act on a repository only where an inbound route already delivers it");
  console.log("to you: subscribe first, and you write only where you receive.");
  console.log("Every write is read back; a result carrying WARNING is unconfirmed, so check");
  console.log("with `comments` before writing again. See docs/inbound.md.");
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}

export async function runIssue(args: string[]): Promise<void> {
  loadEnvFile();
  const [repo, verb] = args;
  if (!repo || repo === "help" || repo === "--help" || repo === "-h" || !verb) {
    usage();
    return;
  }

  const flag = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const num = (name: string): number | undefined => {
    const v = flag(name);
    if (v === undefined) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };

  // `--body -` reads stdin, because a finding worth posting is longer than a
  // line and shell quoting mangles exactly the parts that matter: newlines,
  // quotes, and the error text being cited.
  let body = flag("body");
  if (body === "-") body = await readStdin();

  const params = {
    repo, verb,
    issue: num("issue"),
    body,
    title: flag("title"),
    label: flag("label"),
    state: flag("state"),
    count: num("count"),
  };

  let res: { url?: string; data?: unknown; warning?: string };
  try {
    res = (await new WatcherClient(DAEMON_SOCKET_PATH).call_raw("issue", params)) as typeof res;
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    // A refusal from the handler and an unreachable daemon are different
    // answers and must not read alike: one means "not allowed", the other
    // means "nothing was asked".
    console.error(why.includes("ENOENT") || why.includes("connect")
      ? `Could not reach the daemon at ${DAEMON_SOCKET_PATH}. Is it running? (aibroker start)`
      : why);
    process.exitCode = 1;
    return;
  }

  if (args.includes("--json")) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  if (res.url) console.log(res.url);
  if (res.warning) console.log(`WARNING: ${res.warning}`);
  if (res.data !== undefined) {
    console.log(typeof res.data === "string" ? res.data : JSON.stringify(res.data, null, 2));
  }
}
