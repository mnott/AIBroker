/**
 * daemon/mailbox-cli.ts — `aibroker mailbox wait [--session <id>] [--timeout <s>]`.
 *
 * Blocks until this session's mailbox holds a message it has not been shown,
 * prints one summary line per message and exits 0; exits 2 on timeout with
 * nothing printed. Run in the background by the session itself: when it exits,
 * the harness notifies the idle session, which then reads the mailbox
 * (aibroker_receive). This is how machine ingress wakes a session without
 * typing into its input line (ingress.ts).
 *
 * It only peeks. Nothing is consumed or marked shown, so aibroker_receive and
 * the UserPromptSubmit hook still deliver every message.
 */
import { WatcherClient } from "../ipc/client.js";
import { DAEMON_SOCKET_PATH } from "./index.js";

const SUMMARY_MAX = 120;
const POLL_MS = 1000;

interface Pending { from: string; content: string }

export interface MailboxDeps {
  /** The unshown messages for this session (or `session`), oldest first. */
  peek: (session: string | undefined) => Promise<Pending[]>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  out: (line: string) => void;
}

/** `T`..`X` for an Agentish message, the leading `[Tag]` for a tagged one, else `text`. */
function kindOf(content: string): string {
  const first = content.split(/\r?\n/, 1)[0].trim();
  if (/^[TRSQAX]$/.test(first)) return first;
  const tag = /^\[([^\]\s]+)[^\]]*\]/.exec(first);
  return tag ? tag[1] : "text";
}

export function summarise(m: Pending): string {
  // eslint-disable-next-line no-control-regex
  const flat = m.content.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  return `${m.from} | ${kindOf(m.content)} | ${flat.slice(0, SUMMARY_MAX)}`;
}

/** Returns the process exit code: 0 a message arrived, 2 timeout, 1 usage. */
export async function mailboxWait(args: string[], deps: MailboxDeps): Promise<number> {
  let session: string | undefined;
  let timeoutS: number | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--session") session = args[++i];
    else if (args[i] === "--timeout") timeoutS = Number(args[++i]);
    else {
      console.error("Usage: aibroker mailbox wait [--session <id>] [--timeout <s>]");
      return 1;
    }
  }
  if (timeoutS !== undefined && !(timeoutS >= 0)) {
    console.error("--timeout takes a number of seconds");
    return 1;
  }
  const deadline = timeoutS === undefined ? Infinity : deps.now() + timeoutS * 1000;
  for (;;) {
    // A daemon that is down or restarting is not an arrival and not a failure:
    // keep waiting, the mailbox is read again once it answers.
    const messages = await deps.peek(session).catch(() => [] as Pending[]);
    if (messages.length) {
      for (const m of messages) deps.out(summarise(m));
      return 0;
    }
    if (deps.now() >= deadline) return 2;
    await deps.sleep(Math.min(POLL_MS, Math.max(0, deadline - deps.now())));
  }
}

export async function runMailbox(args: string[]): Promise<void> {
  const [verb, ...rest] = args;
  if (verb === "waiters") {
    const r = (await new WatcherClient(DAEMON_SOCKET_PATH).call_raw("mailbox_waiters", {})) as { waiters?: string[] };
    for (const id of r.waiters ?? []) console.log(id);
    process.exit(0);
  }
  if (verb !== "wait") {
    console.error("Usage: aibroker mailbox <wait [--session <id>] [--timeout <s>] | waiters>");
    process.exit(1);
  }
  const client = new WatcherClient(DAEMON_SOCKET_PATH);
  const code = await mailboxWait(rest, {
    peek: async (session) => {
      const r = (await client.call_raw("session_mailbox_peek", { waiter: true, ...(session ? { sessionId: session } : {}) })) as { messages?: Pending[] };
      return r.messages ?? [];
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    out: (l) => console.log(l),
  });
  process.exit(code);
}
