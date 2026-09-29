/**
 * daemon/send-cli.ts — `aibroker send <name> <text...>`.
 *
 * A thin client over the daemon's `send_to_session` handler, so the shell flow
 * needs no MCP. Name resolution, the shell-injection guard, the unsent-text
 * guard and mailbox queueing all stay in the handler; this only carries the
 * request and reports what came back. `dispatch` and `ask` address a PROJECT
 * with a work order; this addresses whatever session the name matches.
 *
 * Text comes from the arguments, or from stdin when there are none — argv
 * mangles multi-line bodies with quotes and backticks.
 */
import { WatcherClient } from "../ipc/client.js";
import { DAEMON_SOCKET_PATH } from "./index.js";

export interface SendDeps {
  call: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  readStdin: () => Promise<string>;
  out: (line: string) => void;
}

/** Returns the process exit code. */
export async function send(args: string[], deps: SendDeps): Promise<number> {
  const [target, ...words] = args;
  if (!target) {
    console.error("Usage: aibroker send <name> <text...>   (or pipe the text on stdin)");
    return 1;
  }
  const message = words.length ? words.join(" ") : (await deps.readStdin()).replace(/\n+$/, "");
  if (!message) {
    console.error("Nothing to send: give the text after the name, or on stdin.");
    return 1;
  }
  let r: Record<string, unknown>;
  try {
    r = await deps.call("send_to_session", { target, message, noReply: true });
  } catch (err) {
    console.error(`send failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const name = (r.name as string | undefined) ?? target;
  deps.out(r.delivered ? `Sent to ${name}` : `Queued for ${name} (not typed yet)${r.note ? ` — ${r.note}` : ""}`);
  return 0;
}

export async function runSend(args: string[]): Promise<void> {
  const code = await send(args, {
    call: (method, params) => new WatcherClient(DAEMON_SOCKET_PATH).call_raw(method, params) as Promise<Record<string, unknown>>,
    readStdin: async () => {
      if (process.stdin.isTTY) return "";
      const chunks: Buffer[] = [];
      for await (const c of process.stdin) chunks.push(Buffer.from(c));
      return Buffer.concat(chunks).toString("utf-8");
    },
    out: (l) => console.log(l),
  });
  if (code !== 0) process.exit(code);
}
