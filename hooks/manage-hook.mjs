#!/usr/bin/env node
/**
 * manage-hook.mjs — turn `/manage …` into a call on the AIBroker daemon.
 *
 * WHAT THIS CAN AND CANNOT DO — corrected after watching it fail.
 *
 * The first version of this comment said a prompt hook "runs before the model
 * sees anything, so /manage reaches the daemon whether or not the session is
 * mid-work". That was never tested against a BUSY session and it is false. The
 * terminal owns its input line: it queues what you type while a turn is
 * running, and it rejects slash commands it does not recognise, both before any
 * hook is consulted. So the input box cannot carry a control channel on its own.
 *
 * What survives a busy session is `/btw`, which injects into the running turn
 * rather than queueing behind it — and injected messages do reach this hook.
 * The answer, though, cannot be rendered inline while the turn runs, so it is
 * also posted as a notification, which nothing can swallow.
 *
 * The channel that always works is neither: `aibroker manage <session> …` from
 * any other shell, which never touches the terminal being managed.
 */

import net from "node:net";

const SOCKET = "/tmp/aibroker.sock";

function readStdin() {
  return new Promise((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (buf += d));
    process.stdin.on("end", () => resolve(buf));
    // A hook that hangs blocks the prompt. Bounded, always.
    setTimeout(() => resolve(buf), 2_000);
  });
}

function hub(method, params) {
  return new Promise((resolve) => {
    const sock = net.connect(SOCKET);
    let buf = "";
    const done = (v) => {
      try { sock.end(); } catch {}
      resolve(v);
    };
    sock.on("connect", () => sock.write(JSON.stringify({ method, params }) + "\n"));
    sock.on("data", (d) => {
      buf += d;
      try { done(JSON.parse(buf)); } catch { /* keep reading */ }
    });
    sock.on("error", (e) => done({ ok: false, error: `hub unreachable: ${e.code ?? e.message}` }));
    setTimeout(() => done({ ok: false, error: "hub did not answer" }), 8_000);
  });
}

const raw = await readStdin();
let payload = {};
try { payload = JSON.parse(raw); } catch { /* not a hook payload; pass through */ }

/**
 * A TRACE, because "the hook did not fire" and "the hook fired and did nothing"
 * look identical from the terminal — and telling them apart by reasoning is how
 * an evening gets spent on the wrong half. Every invocation lands here whether
 * or not it is ours, so the file answers the only question that matters first:
 * does the terminal call this at all, in this session, right now.
 */
try {
  const { appendFileSync } = await import("node:fs");
  const t = new Date().toTimeString().slice(0, 8);
  appendFileSync("/tmp/manage-hook.log", `[${t}] invoked — prompt=${JSON.stringify(String(payload.prompt ?? "").slice(0, 80))}\n`);
} catch { /* a trace that breaks the hook is worse than no trace */ }

const prompt = String(payload.prompt ?? "");

/**
 * WHICH FORMS TO ACCEPT, and why more than one.
 *
 * `/manage …` is the obvious spelling and it only works when the session is
 * idle: the terminal resolves slash commands itself, queues anything typed
 * while a turn is running, and rejects ones it does not recognise — so the
 * input box cannot carry a control channel on its own. Both of those were
 * observed rather than reasoned about.
 *
 * `/btw manage …` is the way in that survives a busy session, because it
 * injects into the running turn rather than queueing behind it, and injected
 * messages do reach this hook. That is the form worth typing when it matters,
 * which is precisely when the session is busy.
 */
/**
 * THE FORM THAT ACTUALLY REACHES HERE IS THE PLAIN ONE.
 *
 * A trace of every invocation settled this after two wrong guesses. Ordinary
 * prompts DO reach this hook, in every session, including ones started before
 * it was registered — so "hooks are read at session start" was false. What
 * never arrives is `/btw`: of thirteen `/btw` lines in the trace, twelve were
 * this script being run directly by hand and the thirteenth was a paste. Not
 * one genuine `/btw` submission has ever been seen here. It bypasses prompt
 * hooks altogether, which is consistent with it also reaching a model that has
 * no tools — it is not a prompt submission at all.
 *
 * So the in-session spelling is the bare one: type `aibroker manage status` as
 * an ordinary message. No slash — the terminal rejects slash commands it does
 * not know, before any hook is consulted. It costs no turn, because this
 * answers and blocks. It only works while the session is IDLE, because the
 * terminal queues anything typed during a turn; for a busy session there is no
 * in-terminal path at all and the shell is the answer.
 */
const m =
  prompt.match(/^\s*(?:aibroker|broker)\s+manage\b\s*(.*)$/is) ??
  prompt.match(/^\s*\/manage\b\s*(.*)$/s) ??
  // Kept in case /btw ever starts routing through prompt hooks. Harmless now:
  // nothing matches it, so it costs one regex per prompt and no behaviour.
  prompt.match(/^\s*\/btw\s+(?:aibroker|broker)\s+\/?manage\b\s*(.*)$/s) ??
  prompt.match(/^\s*\/btw\s+\/?manage\b\s*(.*)$/s);
if (!m) process.exit(0); // not ours — say nothing, change nothing

const arg = (m[1] ?? "").trim();

/**
 * THE HOOK HAS TO DECIDE ALONE. There is no model to fall back to.
 *
 * The previous version passed anything it could not classify to the model, on
 * the reasoning that a `/btw` injection has already woken one so interpretation
 * is free. It has woken one, but WITHOUT TOOLS — every `/btw` response reports
 * having none — so the model can read the sentence and do nothing about it.
 * Observed in three separate replies before it was believed.
 *
 * So classification happens here, and it is deliberately not a word list, which
 * failed the first phrasing nobody had thought of. A question is recognisable
 * by its FORM: it ends in a question mark, or it opens with an interrogative.
 * Everything else is an objective when nothing is being managed, and an
 * instruction when something is. That is the natural reading of an imperative
 * sentence and needs no cleverness.
 *
 * The limit, stated because it is real: a question phrased as a statement
 * ("tell me where it is") reads as an instruction and will be carried into the
 * next arming rather than answered. Use the shell for anything subtle.
 */
// `?` is HELP, and it has to be tested before the question-form rule below —
// which matches a trailing question mark and would otherwise turn "?" into
// "status". A bare question mark is the oldest spelling of "how do I use this"
// in any shell, and answering it with a status report is a small wrong answer
// to the one question a newcomer asks first.
const KEYWORD = /^(|status|off|stop|pause|resume|now|help|\?|hands?\s+(on|off).*|set\s+[\s\S]+)$/i;
const QUESTION = /\?\s*$|^(what|what's|whats|how|how's|hows|is|are|where|when|why|who|which|any|anything|tell)\b/i;

/**
 * INTERCEPT ONLY THE FIXED VOCABULARY. Free text goes to the model.
 *
 * The bare spelling `aibroker manage …` is an ordinary message, and blocking
 * one is total: the model never sees it. "aibroker manage should also support
 * pausing" is a sentence about the feature, not a command to it, and the
 * classifier would have taken it as an objective and set a session working on
 * the phrase "should also support pausing".
 *
 * So the hook answers what cannot mean anything else — the keywords, and
 * questions recognised by form — and lets everything else through. The model
 * can run the CLI itself, and in an ordinary turn it HAS tools, unlike the
 * `/btw` path. The cost of passing through is a turn; the cost of a wrong
 * interception is a message that vanished.
 */
const isFixed = KEYWORD.test(arg) || QUESTION.test(arg);
if (!isFixed) process.exit(0);

const arg2 = KEYWORD.test(arg) ? arg : "status";

// WHICH SESSION IS THIS. The hook payload carries Claude Code's own session id
// and the working directory, and neither identifies the terminal pane — two
// sessions can share a directory, and the daemon addresses panes. The terminal
// puts its own id in the environment, the hook inherits it, and it is the one
// identifier that is unambiguous and that the session cannot get wrong.
// ITERM_SESSION_ID looks like "w3t1p0:UUID"; the daemon wants the UUID.
const term = process.env.ITERM_SESSION_ID ?? "";
const session = term.includes(":") ? term.split(":").pop() : (payload.cwd ?? process.env.PWD ?? "");

const r = await hub("manage", { session, arg: arg2, cwd: payload.cwd });
const text = r?.ok ? (r.result?.message ?? "done") : `manage failed: ${r?.error ?? "unknown"}`;

/**
 * WHERE THE ANSWER GOES, and why it is not only back into the session.
 *
 * Blocking the prompt and returning a reason works when the session is idle.
 * When it is BUSY — which is exactly when you want to ask — the terminal shows
 * nothing: the injection is suppressed and the reason never reaches the screen.
 * Observed, not assumed. So the answer is also posted where a busy session
 * cannot swallow it: a notification, which appears whatever any session is
 * doing, and which is the only channel here that is genuinely out of band.
 */
async function notify(body) {
  const { execFile } = await import("node:child_process");
  const esc = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  // First line as the title so it is readable without opening anything; the
  // rest as the body, since a notification truncates and the first line is the
  // part that answers "what is going on".
  const [head, ...tail] = body.split("\n");
  const script = `display notification "${esc(tail.join(" · ").slice(0, 240))}" with title "manage" subtitle "${esc(head.slice(0, 100))}"`;
  await new Promise((res) => execFile("/usr/bin/osascript", ["-e", script], () => res()));
}

await notify(text);

// And still answer inline, for the idle case where the terminal does render it.
console.log(JSON.stringify({ decision: "block", reason: text }));
process.exit(0);
