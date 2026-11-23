/**
 * daemon/mailbox-cli.ts — `aibroker mailbox wait [--session <id>] [--timeout <s>] [--settle <s>]`.
 *
 * Blocks until this session's mailbox holds a message it has not been shown,
 * prints one summary line per message and exits 0; exits 2 on timeout with
 * nothing printed. Run in the background by the session itself: when it exits,
 * the harness notifies the idle session, which then reads the mailbox
 * (aibroker_receive). This is how machine ingress wakes a session without
 * typing into its input line (ingress.ts).
 *
 * --settle <s> (default 20, env AIBROKER_MAILBOX_SETTLE_S; 0 = old behaviour):
 * after the first message arrives, keep waiting until no new message has landed
 * for s seconds — at most 60 s from the first arrival — then print them all at
 * once, so a burst of notices wakes the session once instead of once per
 * message. Nothing is dropped or delayed beyond the cap.
 *
 * Beat entries (kind "beat", the cache keepalive) never wake it. While waiting
 * it prints one "waiting since HH:MM" line per --heartbeat seconds (default 1200,
 * 0 = off) so the harness sees output. It only peeks. Nothing is consumed or marked shown, so aibroker_receive and
 * the UserPromptSubmit hook still deliver every message.
 *
 * --follow: never exit on a message — print one line per new unshown message
 * (same format, same --settle burst grouping) and keep running. Intended for
 * Claude Code's Monitor tool, where each stdout line becomes a notification;
 * no restart per message. Exits only on SIGTERM/SIGINT, a lost session, or a
 * fatal daemon error (a final line says why, exit non-zero).
 */
import { WatcherClient } from "../ipc/client.js";
import { DAEMON_SOCKET_PATH } from "./index.js";

const SUMMARY_MAX = 120;
const POLL_MS = 1000;

interface Pending { from: string; content: string; kind?: string }

export interface MailboxDeps {
  /** The unshown messages for this session (or `session`), oldest first. */
  peek: (session: string | undefined) => Promise<Pending[]>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  out: (line: string) => void;
}

const HEARTBEAT_DEFAULT_S = 1200;
const SETTLE_DEFAULT_S = 20;
/** Hard cap on the settle window, measured from the first arrival. */
const SETTLE_CAP_S = 60;

function envSettleDefault(): number {
  const v = Number(process.env.AIBROKER_MAILBOX_SETTLE_S);
  return Number.isFinite(v) && v >= 0 ? v : SETTLE_DEFAULT_S;
}

function hhmm(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** `T`..`X` for an Agentish message, the leading `[Tag]` for a tagged one, else `text`. */
function kindOf(content: string): string {
  const first = content.split(/\r?\n/, 1)[0].trim();
  if (/^[TRSQAX]$/.test(first)) return first;
  const tag = /^\[([^\]\s]+)[^\]]*\]/.exec(first);
  return tag ? tag[1] : "text";
}

/** Unshown non-beat messages; a daemon that is down or restarting is not an arrival. */
async function peekReal(session: string | undefined, deps: MailboxDeps): Promise<Pending[]> {
  return (await deps.peek(session).catch(() => [] as Pending[])).filter((m) => m.kind !== "beat");
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
  let heartbeatS = HEARTBEAT_DEFAULT_S;
  let settleS = envSettleDefault();
  let follow = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--session") session = args[++i];
    else if (args[i] === "--timeout") timeoutS = Number(args[++i]);
    else if (args[i] === "--heartbeat") heartbeatS = Number(args[++i]);
    else if (args[i] === "--settle") settleS = Number(args[++i]);
    else if (args[i] === "--follow") follow = true;
    else {
      console.error("Usage: aibroker mailbox wait [--session <id>] [--timeout <s>] [--heartbeat <s>] [--settle <s>] [--follow]");
      return 1;
    }
  }
  if (timeoutS !== undefined && !(timeoutS >= 0)) {
    console.error("--timeout takes a number of seconds");
    return 1;
  }
  if (!(settleS >= 0)) {
    console.error("--settle takes a number of seconds (0 = return at the first arrival)");
    return 1;
  }
  if (!(heartbeatS >= 0)) {
    console.error("--heartbeat takes a number of seconds (0 = off)");
    return 1;
  }
  const started = deps.now();
  let nextBeat = heartbeatS > 0 ? started + heartbeatS * 1000 : Infinity;
  const deadline = timeoutS === undefined ? Infinity : deps.now() + timeoutS * 1000;
  for (;;) {
    // A daemon that is down or restarting is not an arrival and not a failure:
    // keep waiting, the mailbox is read again once it answers.
    // Cache beats are not a wake-up: the prompt hook still shows them.
    const messages = await peekReal(session, deps);
    if (messages.length) {
      // --settle: one wake covers a burst. Keep collecting until settleS seconds
      // pass with no new message, hard-capped at SETTLE_CAP_S from the first
      // arrival; the timeout deadline still wins over the window.
      if (settleS > 0) {
        const capAt = deps.now() + SETTLE_CAP_S * 1000;
        // The quiet window closes settleS after the LAST arrival — not after
        // "now", which would slide it forward on every pass and never close
        // before the cap.
        let lastArrival = deps.now();
        let lastCount = messages.length;
        for (;;) {
          const nowMs = deps.now();
          // sleep to the earlier of: the quiet window closing (settleS after
          // the last arrival), the hard cap, and the timeout deadline.
          const wakeAt = Math.min(lastArrival + settleS * 1000, capAt, deadline);
          if (!(wakeAt > nowMs)) break;
          await deps.sleep(Math.min(POLL_MS, wakeAt - nowMs));
          const more = await peekReal(session, deps);
          if (more.length > lastCount) {
            messages.length = 0;
            messages.push(...more);
            lastCount = more.length;
            lastArrival = deps.now(); // a new arrival restarts the quiet window
          }
        }
      }
      if (follow) {
        // --follow: stream, never exit. Print the burst and keep going — each
        // line is a Monitor notification, so no per-message restart churn.
        for (const m of messages) deps.out(summarise(m));
        continue;
      }
      for (const m of messages) deps.out(summarise(m));
      return 0;
    }
    if (!follow && deps.now() >= deadline) return 2;
    if (deps.now() >= nextBeat) {
      deps.out(`waiting since ${hhmm(started)}`);
      nextBeat = deps.now() + heartbeatS * 1000;
    }
    await deps.sleep(follow ? POLL_MS : Math.min(POLL_MS, Math.max(0, deadline - deps.now())));
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
    console.error("Usage: aibroker mailbox <wait [--session <id>] [--timeout <s>] [--heartbeat <s>] [--settle <s>] | waiters>");
    process.exit(1);
  }
  const client = new WatcherClient(DAEMON_SOCKET_PATH);
  let aborted = false;
  let fatalReason: string | undefined;
  process.on("SIGTERM", () => { aborted = true; process.exit(0); });
  process.on("SIGINT", () => { aborted = true; process.exit(0); });
  const code = await mailboxWait(rest, {
    peek: async (session) => {
      if (aborted) throw new Error("wait aborted");
      try {
        const r = (await client.call_raw("session_mailbox_peek", { waiter: true, ...(session ? { sessionId: session } : {}) })) as { messages?: Pending[] };
        return r.messages ?? [];
      } catch (err) {
        if (!aborted && err instanceof Error && /session not found|unknown session/i.test(err.message)) {
          fatalReason = err.message;
          aborted = true;
        }
        throw err;
      }
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    out: (l) => console.log(l),
  });
  if (fatalReason) {
    console.error(`mailbox wait: session lost — ${fatalReason}`);
    process.exit(1);
  }
  process.exit(code);
}
