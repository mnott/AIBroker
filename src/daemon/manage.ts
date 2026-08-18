/**
 * daemon/manage.ts — keep a session working on a standing objective.
 *
 * THE PROBLEM THIS SOLVES. A session driven by a goal decides at the end of a
 * cycle whether the goal was met, and then stops. Left alone it stops for the
 * night; re-armed, it works for as long as you let it. Two nights of running
 * that by hand produced sixteen hours of unattended work and a list of ways the
 * arrangement breaks, all of which are answered here.
 *
 * WHY IT LIVES IN THE DAEMON RATHER THAN IN A SESSION. The first version was a
 * script driven from another Claude session, which worked and cost that session
 * its whole context — and worse, talking to the manager meant interrupting the
 * manager, because observing occupied the same turn the instruction would have
 * arrived on. An instrument that consumes the channel it is watched through
 * cannot be redirected without being stopped. So: a process with a mailbox.
 * Writing to a mailbox never requires the reader to be idle.
 *
 * WHAT IT DOES NOT DO. It does not judge the work. It re-arms an objective, it
 * carries one-shot instructions from the operator into the next arming, and it
 * says what it did. Everything requiring judgement stays with the person.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { log } from "../core/log.js";
import { readSessionContent } from "./session-content.js";
import { typeIntoSession } from "../transport/sync-facade.js";
import { discoverLiveSessions } from "../core/session-discovery.js";
import { hasPailotClients } from "../adapters/pailot/gateway.js";
import { getAibpBridge } from "../core/state.js";
import { listDialogs, answerDialog } from "./dialogs.js";

const STATE_FILE = join(homedir(), ".aibroker", "managers.json");

/** How often every manager is looked at. Cheap: one content read per managed session. */
const TICK_MS = 20_000;

/**
 * A session with no goal is not working on one, whatever else it is doing.
 *
 * The first version also required a long silence, and that never fired: a
 * session answering messages moves its transcript and resets any quiet timer,
 * so the loop waited for a silence that conversation kept postponing. The grace
 * below exists only to avoid arming in the middle of the turn that just ended
 * the last goal.
 */
const NO_GOAL_GRACE_MS = 30_000;

/** Never re-arm twice inside this window, whatever the signals say. */
const REARM_COOLDOWN_MS = 90_000;

/**
 * How many times a goal may be typed without confirmation before giving up.
 *
 * Small on purpose. Each attempt is a whole objective pasted into the session's
 * input; against a busy session those queue rather than run, and a queue of
 * goals fires in sequence later against whatever state exists by then. Three is
 * enough to ride out a slow screen read and few enough that the queue stays
 * harmless if none of them landed.
 */
const ARM_ATTEMPTS = 3;

/**
 * How long an armed goal is believed before the manager stops waiting for it.
 *
 * Not a timeout on the work. A ceiling on the manager's willingness to sit on a
 * signal that may never arrive — an item can legitimately end without the
 * marker clearing, and a loop with no ceiling waits forever while every
 * heartbeat reads healthy.
 */
const GOAL_MAX_AGE_MS = 45 * 60_000;

/**
 * The status-line marker shown while a goal is armed.
 *
 * IT IS A PROXY AND IT LIES. Read off the terminal, it does not clear when the
 * goal is met — it once read "active" for ninety minutes after the session had
 * finished, committed six times and gone idle. It is used here only in
 * conjunction with the age ceiling above, never on its own.
 */
const GOAL_ACTIVE = /\/goal\s+active/i;

/**
 * Where a session is asked to hand over, as a share of its context.
 *
 * NOT where it dies — where it should stop and write down what it knows while
 * it still can. A session at the wall cannot compose a handover, because
 * composing one is exactly the sort of work it no longer has room for. The
 * margin has to be big enough to write in.
 *
 * Deliberately conservative. Rolling over early costs one cycle of re-reading a
 * file; rolling over late costs everything the session had not written down,
 * and that loss is silent — the successor does not know what it was not told.
 */
const HANDOVER_AT = 0.82;

/**
 * How long the manager waits for the handover before giving up on it.
 *
 * A rollover that hangs is worse than no rollover: the session is paused, not
 * working, and nobody is told. If the handover does not arrive the manager says
 * so and leaves the session alone rather than clearing it — clearing a session
 * that failed to write its handover destroys precisely what the rollover
 * existed to preserve.
 */
const HANDOVER_GRACE_MS = 6 * 60_000;

/**
 * How long a managed session may show no change at all before it is armed.
 *
 * Chosen well above any turn that is merely slow — builds, long test runs and
 * an agent thinking hard all move the screen inside this — so that firing means
 * something is actually wrong rather than something is taking a while. The
 * penalty for firing early is one queued prompt; the penalty for firing late is
 * measured in hours of a session sitting at an empty prompt, so the number
 * leans towards firing.
 */
const STUCK_AFTER_MS = 12 * 60_000;

/**
 * The startup banner, which is the pane's only POSITIVE evidence of a clear.
 *
 * The first version of this test asked the opposite question — whether the
 * goal's words had left the screen — and that was wrong in a way worth
 * recording, because it looked obviously right. A pane scrolls. The words of a
 * goal set an hour ago are gone from it during any long turn, so their absence
 * is the normal condition of a working session, not the signature of a cleared
 * one. It declared every rollover complete the moment the clear was typed.
 *
 * A banner is drawn on exactly two occasions: the session starting, and the
 * session being cleared. Inside the window where a clear has just been typed,
 * only the second is possible.
 */
const CLEARED_BANNER = /Claude Code v\d/;

/**
 * How long a clear may stay unaccounted for before the guard lets go.
 *
 * The guard exists so a second clear is never typed while one is outstanding,
 * and that is right. But it was released by exactly one event — seeing a clear
 * land — and an event that may never happen is not a release, it is a lock: an
 * operator who deletes the queued clear, or a terminal that drops it, leaves
 * the session unable to roll over again for the rest of its life. That is a
 * worse failure than the one being prevented, and quieter.
 *
 * The interval is long because it is a backstop, not a retry. Nothing here
 * hurries: a rollover still has to earn its way back by writing a handover
 * first, which takes minutes and cannot be faked.
 */
const CLEAR_PENDING_MAX_MS = 30 * 60_000;

/**
 * How long before a session that has handed over is asked to do it again.
 *
 * Needed only because the handover no longer ends in a clear. The context that
 * triggered the request stays high afterwards — that is the point, the session
 * keeps its context and keeps working — so without a cooldown the threshold
 * re-qualifies it on the very next tick and it is interrupted every twenty
 * seconds to write the same file.
 *
 * A session that keeps its handover current as it works, which is the habit
 * this encourages, will usually have nothing to add when re-asked. The
 * interval is set for the case where it does.
 */
const HANDOVER_REASK_MS = 30 * 60_000;

/**
 * How much NEW work may accumulate before the handover is asked for again.
 *
 * A time cooldown alone left the gap this closes. The handover is written at
 * the threshold and the session then keeps working to the wall — on a 1M
 * window that is nearly 200k tokens of thinking that the file does not
 * describe, and it is exactly the stretch compaction throws away. The document
 * meant to survive compaction was reliably stale by the moment it was needed.
 *
 * Measured in context growth rather than minutes because that is what the risk
 * is actually made of: an idle hour costs nothing, and twenty minutes of hard
 * work costs everything not written down.
 */
const HANDOVER_REASK_K = 120;

/**
 * A floor under re-asking, so growth cannot trigger a stream of requests.
 *
 * Writing a handover itself consumes context, so without this a session near
 * the wall could be asked again almost immediately on the strength of the
 * growth its own last handover caused.
 */
const HANDOVER_MIN_GAP_MS = 8 * 60_000;


/**
 * Input the terminal is holding rather than running.
 *
 * A `/clear` typed into a session that is mid-turn does not execute; it waits,
 * and the terminal says so. Seeing this means the clear has NOT landed however
 * fresh the rest of the screen looks, so it vetoes the banner test — a banner
 * still on screen from a session's own start would otherwise be read as proof
 * of a clear that is still sitting in the queue.
 */
const QUEUED_INPUT = /queued message/i;

/** Verdicts that mean the session has run out of goal and said so. */
const OUT_OF_GOAL = [
  /goal could not be achieved/i,
  /goal not achieved/i,
  /could not achieve the goal/i,
];

export interface ManagedSession {
  sessionId: string;
  /** Human name at the time of starting, for logs only — sessions get renamed. */
  name: string;
  /** The standing objective, re-armed whenever it lapses. */
  objective: string;
  /** Operator instructions waiting to go out with the next arming. */
  pending: string[];
  /** Everything the manager has done, newest last, capped. */
  history: { at: string; what: string }[];
  lastRearmAt: number;
  lastChangeAt: number;
  lastHash: string;
  paused: boolean;
  /**
   * The file the session hands over in — a TEMPLATE, not a fixed path.
   *
   * `{date}`, `{yyyy}`, `{mm}` and `{dd}` are expanded when the file is used
   * rather than when it is set, because a session that runs for days outlives
   * the day it was started on. A literal date written into the path was right
   * for one evening and then quietly wrong: the request kept naming yesterday's
   * file, and the drift grows by a day every day.
   */
  handoverFile?: string;
  /** The path actually asked for, so a date rolling over mid-episode cannot
   *  make the change check compare two different files. */
  handoverAskedPath?: string;
  /**
   * Clear the session after the handover, rather than leaving it to compact.
   * OFF unless asked for — see the rollover block for what changed this.
   */
  clearAfterHandover?: boolean;
  /** Consecutive armings typed but never seen to land. Bounded — see ARM_ATTEMPTS. */
  armFails?: number;
  /** When a handover was last obtained, so it is not demanded every tick. */
  handoverDoneAt?: number;
  /** The context reading when it was obtained, so "how much work since" is
   *  answerable — a handover ages by work done, not by the clock. */
  handoverDoneK?: number;
  /** When a handover was asked for, so a silent session can be given up on. */
  handoverAskedAt?: number;
  /** What that file looked like when asked, so "changed" is measured not claimed. */
  handoverWas?: string;
  /** When a clear was typed, so it is never typed twice WITHIN one rollover. */
  clearTypedAt?: number;
  /**
   * When a clear was typed that has never been seen to land — ACROSS rollovers.
   *
   * The per-rollover guard was not enough and the gap was ugly: a session whose
   * context stays high keeps qualifying for rollover, so each new attempt typed
   * its own clear, and a session in a turn long enough to execute none of them
   * accumulated a queue of them. They would then all fire in sequence, the
   * first against the session they were meant for and the rest against whatever
   * fresh session had started since — which is the exact "wipe the session that
   * just started" failure the single-clear rule existed to prevent, reached by
   * going around it rather than through it.
   *
   * So the invariant is stronger than "one clear per rollover": at most one
   * unconfirmed clear per session, ever, and no new rollover may begin while
   * one is outstanding.
   */
  clearPendingSince?: number;
  /** Context before the clear, so "it landed" is measured against something. */
  contextAtClear?: number;
  /** The pane, so the process and thence the checkout can be found again. */
  tty?: string;
  /** Screen work forbidden — the operator has the machine. Survives re-arming. */
  noScreen?: boolean;
  /** When the current screen decision reverts by itself. A grant that only ends
   *  when somebody remembers to end it outlives the reason it was given for. */
  handsUntil?: number;
  /** Which state the timer was set in, so reverting means the opposite of it. */
  handsWas?: boolean;
  /**
   * The checkout this session's state belongs to, decided once.
   *
   * It used to be resolved fresh on every write, from whatever the pane's
   * process happened to be reading. That is right for a session that moves and
   * catastrophic for several sessions at once: a mis-resolution then writes one
   * worker's state over another's, silently, in a checkout neither of them is
   * working in. It has already put a file in an unrelated repository once.
   *
   * So it is pinned when management starts. If the live answer later disagrees,
   * nothing is written and it is said out loud once — a mirror that follows the
   * pane to a new repository is not a mirror, it is a second author.
   */
  repoRoot?: string;
  /** Said once when the pane's checkout stopped matching the pinned one. */
  repoDriftReported?: boolean;
  /**
   * A bounded stretch of autonomous work on the tracker's open issues.
   *
   * This exists because the operator was writing the same long paragraph every
   * night — which list, in what order, report where, commit how, screen or no
   * screen, for how long — and any clause forgotten in a hurry was a rule that
   * silently did not apply. A shift is that paragraph reduced to its three
   * variables: how long, with the screen or without, and how many workers.
   */
  shift?: {
    /** When it ends. Stopping claiming is not the same as being killed. */
    until: number;
    /** Upper bound on concurrent workers. See the fleet design note. */
    workers: number;
    /** Whether the screen was handed over for the duration. */
    visual: boolean;
    startedAt: number;
    /** Said once, so the end of a shift is announced and not merely obeyed. */
    endReported?: boolean;
  };
  startedAt: number;
}

type State = Record<string, ManagedSession>;

/**
 * A duration nobody can print nonsense from.
 *
 * The defect this closes: a sentinel `0` meaning "no timestamp" was subtracted
 * from the clock and formatted as an age, so a log line read "armed 29,779,818
 * min" — the age of the Unix epoch, internally correct and externally absurd.
 * One code path was fixed; this closes the class, because the next path to
 * format a duration from a suspect timestamp would have printed it again.
 *
 * Anything beyond a month is not a duration in this system, it is a bad
 * subtraction, and saying so is more useful than a number with eight digits.
 */
const IMPLAUSIBLE_MS = 31 * 24 * 60 * 60_000;
function minutesSince(then: number, now: number): string {
  const ms = now - then;
  if (!Number.isFinite(ms) || ms < 0 || ms > IMPLAUSIBLE_MS) return "an unknown time";
  return `${Math.round(ms / 60000)} min`;
}

/**
 * Repair history lines produced by that defect, once, on load.
 *
 * Normally a log is struck forward rather than rewritten — a record that edits
 * its own history is worth less than one that does not. This is the exception
 * and it is narrow: the line is not a claim anybody needs to audit, it is a
 * garbled rendering of an event that did happen, produced by a bug that no
 * longer exists. What it records is preserved; only the impossible number goes.
 */
function repairHistory(s: State): boolean {
  let changed = false;
  for (const m of Object.values(s)) {
    for (const h of m.history ?? []) {
      const bad = h.what.match(/armed (\d{7,}) min/);
      if (bad) {
        h.what = h.what.replace(bad[0], "armed for an unknown time (a defect in this manager's own arithmetic, fixed 2026-08-15)");
        changed = true;
      }
    }
  }
  return changed;
}

function loadState(): State {
  try {
    if (existsSync(STATE_FILE)) {
      const s = JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
      if (repairHistory(s)) {
        saveState(s);
        log("[manage] repaired history lines left by the epoch-duration defect");
      }
      return s;
    }
  } catch (e) {
    log(`[manage] state unreadable, starting empty — ${(e as Error).message}`);
  }
  return {};
}

function saveState(s: State): void {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch (e) {
    log(`[manage] could not save state — ${(e as Error).message}`);
  }
  for (const m of Object.values(s)) mirrorToRepo(m);
}

/**
 * Put what a session knows INTO THE PROJECT, not beside it.
 *
 * On one machine this is tidiness. Across machines it is the entire
 * synchronisation mechanism: git already moves work between developers, so
 * knowledge committed to the repository travels with the branch, merges with
 * the branch and arrives on every machine without anybody building a protocol
 * for it. Knowledge in a home directory reaches exactly one machine, and which
 * machine that is depends on where somebody happened to be sitting.
 *
 * The same argument in the other direction is why this file is not the record:
 * `~/.aibroker` is per-machine state — sockets, tokens, timers — and that is
 * correct for things that describe a machine. An objective describes the WORK,
 * so it belongs where the work is.
 *
 * Written as markdown rather than the state JSON because the reader is the next
 * agent to open the repository, possibly on another machine, possibly weeks
 * later. It should not need this program to make sense of what it finds.
 */
function mirrorToRepo(m: ManagedSession): void {
  try {
    // Resolve the pane NOW rather than trusting one recorded at creation.
    // A field captured once is a field that is absent on every record made
    // before it existed and wrong for any session that has since moved — and
    // both of those fail silently, which is how a mirror stops mirroring
    // without anybody noticing.
    const tty = m.tty ?? snapshotTty(m.sessionId);
    const proc = tty ? processReading(tty) : { isSession: false, pid: null };
    if (!proc.pid) return;
    const live = repoRootFor(proc.pid);
    if (!live) return;

    // Pin on the first successful resolution — including for sessions that
    // were being managed before this field existed, which is why it is set
    // here rather than only at creation.
    if (!m.repoRoot) m.repoRoot = live;

    if (m.repoRoot !== live) {
      // Positive evidence, not a guess: the pane is reading a different
      // checkout than the one this session's state belongs to. Refuse, and say
      // so once — repeating it every twenty seconds would bury the log.
      if (!m.repoDriftReported) {
        m.repoDriftReported = true;
        log(`[manage:${m.name}] pane is now in a different checkout than the one pinned at start — not mirroring state, to avoid writing it into somebody else's repository`);
      }
      return;
    }
    const cwd = m.repoRoot;

    const dir = join(cwd, ".aibroker");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const recent = m.history.slice(-12).map((h) => `- ${h.at} — ${h.what}`).join("\n");
    const body =
      `# Session: ${m.name}\n\n` +
      `_Written by the manager. It travels with this branch, which is the point:\n` +
      `whichever machine picks this work up next reads it here rather than\n` +
      `rediscovering it._\n\n` +
      `## Standing objective\n\n${m.objective}\n\n` +
      (m.pending.length ? `## Waiting to be carried into the next cycle\n\n${m.pending.map((p) => `- ${p}`).join("\n")}\n\n` : "") +
      (m.noScreen ? `## Screen\n\nScreen work is currently withheld - the operator has the machine.\n\n` : "") +
      `## Recent\n\n${recent || "- nothing yet"}\n`;

    const file = join(dir, `session-${m.name.replace(/[^A-Za-z0-9._-]/g, "-")}.md`);
    // Only write on change. A file rewritten every twenty seconds turns a
    // repository into a stream of no-op commits and trains everyone to ignore it.
    const before = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (before !== body) writeFileSync(file, body);
  } catch (e) {
    log(`[manage] could not mirror into the repository — ${(e as Error).message}`);
  }
}

/**
 * A cheap fingerprint of a file, or "" if it is not there.
 *
 * Size and modification time rather than a hash: this runs every twenty seconds
 * against a file that may be hundreds of kilobytes, and the question is only
 * "did it change", which those two answer without reading anything. An absent
 * file fingerprints as empty so that CREATING one counts as a change — the
 * first handover a session ever writes is exactly the case a naive comparison
 * would miss.
 */
function fileFingerprint(path: string): string {
  try {
    const s = statSync(path);
    return `${s.size}:${Math.round(s.mtimeMs)}`;
  } catch {
    return "";
  }
}

/** This session's context in thousands of tokens, from its own transcript. */
function contextK(m: ManagedSession): number | null {
  const tty = m.tty ?? snapshotTty(m.sessionId);
  const pid = tty ? processReading(tty).pid : null;
  return pid ? transcriptReading(pid).contextK : null;
}

/**
 * Close a rollover out, however it ended, and guarantee an arming follows.
 *
 * EVERY exit from a rollover goes through here, which is the point. When the
 * clearing of this state and the scheduling of the next arming are separate
 * acts at separate call sites, some branch eventually does the first without
 * the second — and that branch leaves a cleared session sitting at an empty
 * prompt, reporting "working", for as long as the ordinary arming rules take to
 * notice. Binding the two together makes that combination unwriteable.
 *
 * `lastRearmAt = 0` is the sentinel that says arm on the next tick regardless
 * of the on-screen goal marker. That is not a shortcut: after a clear the
 * marker is a leftover from a screen that no longer exists, so the one signal
 * that would hold the arming back is also the one signal guaranteed to be
 * stale.
 */
function endRollover(m: ManagedSession): void {
  delete m.handoverAskedAt;
  delete m.handoverWas;
  delete m.clearTypedAt;
  delete m.contextAtClear;
  // clearPendingSince deliberately survives: it records a clear that is still
  // out there somewhere, and forgetting it is what let a second one be typed.
  m.lastRearmAt = 0;
}

/** A clear was seen to land. Forget it, and let rollovers happen again. */
function clearLanded(m: ManagedSession): void {
  delete m.clearPendingSince;
  endRollover(m);
}

/**
 * Is there text sitting unsent in the session's prompt?
 *
 * TYPING ON TOP OF IT DESTROYS IT. The manager pastes into the same input line
 * a person types into, and it sends a backspace first to escape vi normal
 * mode — so an objective armed over half-typed text eats a character of that
 * text and then runs the two together as one prompt. The operator's sentence
 * and the standing objective arrive merged and mangled, and neither does what
 * it meant to.
 *
 * This never bit while nobody was at the keyboard, which is exactly the kind of
 * assumption that holds until an operator sits down at seven in the morning and
 * starts a sentence.
 *
 * The live input line is the one enclosed by the terminal's rules at the foot
 * of the pane, not the `❯` lines further up — those are scrollback, commands
 * that already ran. So the rule immediately above it is what identifies it.
 */
export function promptUnsentText(content: string): string | null {
  const lines = content.split("\n");
  for (let i = 1; i < lines.length; i++) {
    // The rule may carry a title — "──── Name ──" — so match its start, not
    // the whole line. Requiring the run of box-drawing characters up front
    // keeps this from matching prose that happens to begin with a dash.
    const isRuleAbove = /^\s*[─—-]{10,}/.test(lines[i - 1]);
    if (!isRuleAbove) continue;
    const m = lines[i].match(/^\s*❯\s*(.*)$/);
    if (!m) continue;
    const typed = m[1].trim();
    // The terminal's own hint about held input is not the operator's text.
    if (!typed || /^press up to edit/i.test(typed)) continue;
    return typed;
  }
  return null;
}

export function promptHasUnsentText(content: string): boolean {
  return promptUnsentText(content) !== null;
}

/**
 * Expand the date tokens in a handover path, against the clock right now.
 *
 * Deliberately resolved at the moment of use. A managed session is meant to
 * outlive the day it started on, so any date fixed at the moment the path was
 * SET is a date that will be wrong by morning — and wrong in the quietest way,
 * since the file it names still exists and still opens.
 *
 * Exported for the tests, which is also where the accepted tokens are pinned.
 */
export function resolveHandoverPath(template: string, at: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const yyyy = String(at.getFullYear());
  const mm = p(at.getMonth() + 1);
  const dd = p(at.getDate());
  return template
    .replace(/\{date\}/gi, `${yyyy}-${mm}-${dd}`)
    .replace(/\{yyyy\}/gi, yyyy)
    .replace(/\{mm\}/gi, mm)
    .replace(/\{dd\}/gi, dd);
}

/** Did the handover actually land? Read the file; do not believe the session. */
function handoverChanged(m: ManagedSession): boolean {
  // The path asked for, not the template resolved afresh: if the clock crossed
  // midnight between the request and this check, resolving again would compare
  // a file nobody was asked to write against a fingerprint taken from another.
  const path = m.handoverAskedPath ?? (m.handoverFile ? resolveHandoverPath(m.handoverFile) : undefined);
  if (!path) return false;
  return fileFingerprint(path) !== (m.handoverWas ?? "");
}

/** The pane device for a session, captured once at start. */
function snapshotTty(sessionId: string): string | undefined {
  return discoverLiveSessions().find((s) => s.id === sessionId)?.tty;
}

/** The checkout a process is sitting in, or null if it is not in one. */
/**
 * The checkout a session is working in, or undefined when it cannot be told.
 *
 * Undefined is a real answer here and must not be faked: a session whose
 * checkout is unknown gets no mirror at all, which is better than a mirror
 * written somewhere plausible.
 */
function repoRootForSession(sessionId: string): string | undefined {
  const tty = snapshotTty(sessionId);
  if (!tty) return undefined;
  const proc = processReading(tty);
  if (!proc.pid) return undefined;
  return repoRootFor(proc.pid) ?? undefined;
}

function repoRootFor(pid: string): string | null {
  try {
    const cwdOut = execFileSync("/usr/sbin/lsof", ["-p", pid, "-a", "-d", "cwd", "-Fn"], {
      encoding: "utf8",
      timeout: 4_000,
    });
    const cwd = cwdOut.split("\n").find((l) => l.startsWith("n"))?.slice(1);
    if (!cwd) return null;
    const root = execFileSync("/usr/bin/env", ["git", "-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      timeout: 4_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return root || null;
  } catch {
    return null;
  }
}

let state: State = loadState();
let timer: NodeJS.Timeout | null = null;

function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return String(h);
}

function note(m: ManagedSession, what: string): void {
  // Local time, like the daemon log. A history stamped in UTC beside a log
  // stamped locally is two clocks in one investigation, and the whole point of
  // this record is to be read at three in the morning by someone in a hurry.
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const at = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  m.history.push({ at, what });
  if (m.history.length > 40) m.history = m.history.slice(-40);
  log(`[manage:${m.name}] ${what}`);
}

/**
 * Tell the operator something happened, wherever they are.
 *
 * Goes out unconditionally, because the normal path already does the right
 * thing with an absent phone: it pushes over APNs and queues for catch-up. An
 * alert is a MESSAGE — a rollover, a dead session — and a message is still
 * worth reading an hour after it was sent, which is precisely what the queue is
 * for. Gating this on a live connection would mean the events worth waking
 * someone for are the ones only delivered when they were already watching.
 *
 * Failure is swallowed on purpose. The manager's job is keeping a session
 * working; it must not stop doing that because a notification did not go out.
 */
function alertOperator(text: string): void {
  try {
    getAibpBridge()?.routeToMobile("", text, "TEXT");
  } catch (e) {
    log(`[manage] could not reach the phone — ${(e as Error).message}`);
  }
}

/**
 * The periodic reading — sent only if someone is actually looking.
 *
 * The opposite call from an alert, for the opposite kind of content. "Armed
 * twice, 400k context" is worth knowing at the time and worth nothing four
 * hours later, so queueing it would mean picking the phone up to a stack of
 * expired weather reports with the one that mattered somewhere inside. No app
 * connected, no report, and nothing kept to deliver later.
 */
function reportToOperator(text: string): void {
  if (!hasPailotClients()) return;
  alertOperator(text);
}

/**
 * A note that is ALSO worth a buzz on the phone.
 *
 * The line between this and `note` is who caused the event. Anything the
 * operator just did — set an objective, take the screen back, start managing —
 * is recorded and not sent, because telling someone what they themselves just
 * typed is how a notification channel teaches its reader to ignore it. What
 * gets sent is what the MANAGER decided on its own while nobody was watching:
 * a rollover, a session that died, a goal that would not land.
 *
 * Routine armings are not here. They are real, and frequent, and belong in the
 * periodic report where they arrive as a count instead of sixteen buzzes.
 */
function notify(m: ManagedSession, what: string): void {
  note(m, what);
  alertOperator(`${m.name} — ${what}`);
}

/**
 * How often the operator hears from the manager when nothing is wrong.
 *
 * Long, because the report competes with the alerts for the same attention: a
 * channel that speaks every few minutes about nothing is one whose alerts get
 * swiped away unread. Half an hour is roughly "next time you glance at it".
 */
const REPORT_EVERY_MS = 30 * 60_000;

/** When the operator was last told the state of things. */
let lastReportAt = 0;

/**
 * Armings since the last report, per session. NOT persisted, on purpose — the
 * count answers "how much has the manager had to intervene lately", and a
 * figure carried across a daemon restart would answer a different question
 * while looking like that one.
 */
const armingsSinceReport = new Map<string, number>();

/**
 * The periodic reading: what every managed session is doing, in one message.
 *
 * One message for all of them rather than one each, because the useful thing on
 * a phone is a page you take in at a glance, and armings across several
 * sessions are the same event happening in several places.
 */
function reportIfDue(now: number): void {
  const managed = Object.values(state);
  // Nothing is being managed, so there is nothing to report and the clock is
  // held at now — otherwise a report would be overdue the moment one starts.
  if (managed.length === 0) {
    lastReportAt = now;
    return;
  }
  // First tick after a restart. Start the clock rather than reporting, so
  // restarting the daemon is not itself a reason for the phone to buzz.
  if (lastReportAt === 0) {
    lastReportAt = now;
    return;
  }
  if (now - lastReportAt < REPORT_EVERY_MS) return;
  lastReportAt = now;

  const mins = Math.round(REPORT_EVERY_MS / 60_000);
  const lines = managed.map((m) => {
    const armings = armingsSinceReport.get(m.sessionId) ?? 0;
    armingsSinceReport.set(m.sessionId, 0);
    const k = contextK(m);
    const quietFor = Math.round((now - m.lastChangeAt) / 60_000);
    const doing = m.paused ? "paused" : quietFor >= 2 ? `quiet for ${quietFor} min` : "working";
    const last = m.history.at(-1);
    return (
      `• ${m.name} — ${doing}` +
      (k !== null ? `, ${k}k context` : "") +
      `, ${armings} arming${armings === 1 ? "" : "s"} in ${mins} min` +
      (last ? `\n  last: ${last.what.slice(0, 110)}` : "")
    );
  });
  reportToOperator(`Manager report\n${lines.join("\n")}`);
}

/**
 * Resolve a session by whatever the caller knows — its id, or its name.
 *
 * The hook knows the working directory and the terminal session; a person
 * knows the name. Both have to land on the same record.
 */
export function resolveSession(idOrName: string): { sessionId: string; name: string } | null {
  const live = discoverLiveSessions();
  // The terminal's own id may arrive as "w3t1p0:UUID"; the pane is the UUID.
  const id = idOrName.includes(":") ? (idOrName.split(":").pop() ?? idOrName) : idOrName;
  const byId = live.find((s) => s.id === id || s.aibrokerId === id);
  if (byId) return { sessionId: byId.id, name: byId.paiName ?? byId.name ?? id };
  const needle = idOrName.toLowerCase();
  const byName = live.find(
    (s) => (s.paiName ?? "").toLowerCase() === needle || (s.name ?? "").toLowerCase().includes(needle),
  );
  if (byName) return { sessionId: byName.id, name: byName.paiName ?? byName.name ?? idOrName };
  return null;
}

/**
 * What is actually running in this pane, from the PROCESS TABLE.
 *
 * WHY THIS EXISTS AT ALL. Everything below used to be inferred from the text on
 * screen, and that is hopeless: three filters in a row settled on chrome, one of
 * them reporting a "use /clear to free up context" tip as the session's activity
 * for minutes. Parsing a terminal UI means guessing at somebody's prompt theme,
 * their status line and the framework's own banners — a proxy for a question the
 * operating system answers exactly.
 *
 * Each pane has a tty and the session process sits on it. That answers exactly
 * ONE question, which is the one worth asking here: is there a `claude` on this
 * tty at all, or is the pane a bare shell? A goal typed at a shell prompt runs
 * as shell commands — that has happened, and it was harmless only by luck.
 *
 * It does NOT answer "is it working". An earlier version read that from a
 * `caffeinate` child and it discriminated perfectly across five panes — and it
 * is still the wrong thing to depend on, because it is an implementation detail
 * of one client on one operating system. A signal that happens to correlate
 * today is the definition of a proxy, and this file has been caught by four of
 * them already. That question belongs to the transcript below, which is the
 * session's own record rather than a side effect of it.
 */
function processReading(tty: string): { isSession: boolean; pid: string | null } {
  const dev = tty.replace(/^\/dev\//, "");
  let out = "";
  try {
    out = execFileSync("/bin/ps", ["-t", dev, "-o", "pid=,ppid=,etime=,command="], {
      encoding: "utf8",
      timeout: 4_000,
    });
  } catch {
    // No processes on that tty, or ps refused. Either way nothing can be said.
    return { isSession: false, pid: null };
  }

  const rows = out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const m = l.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      return m ? { pid: m[1], ppid: m[2], etime: m[3], cmd: m[4] } : null;
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  const claude = rows.find((r) => /(^|\/)claude$/.test(r.cmd.split(/\s+/)[0]));
  if (!claude) return { isSession: false, pid: null };

  return { isSession: true, pid: claude.pid };
}

/**
 * What the session is doing, from its own transcript — the authority.
 *
 * THE PROCESS TABLE WAS THE SECOND WRONG ANSWER. Reading the screen was the
 * first: three filters in a row settled on chrome. Then `caffeinate`, which
 * discriminated perfectly across five panes and is still wrong to depend on —
 * it is an implementation detail of one client on one operating system, and a
 * signal that happens to correlate today is the definition of a proxy. The
 * question was never "what did this spawn", it is "what is the session doing",
 * and the session writes that down itself.
 *
 * Every session keeps a JSONL transcript: one entry per message, each carrying
 * a timestamp, the tool being called by name, and real token usage. From it,
 * without parsing a single line of terminal output:
 *
 *   - WORKING or NOT: the last entry is a tool call awaiting its result, or it
 *     is finished text. No inference from spinners.
 *   - WHAT: the tool's own name, as the client recorded it.
 *   - CONTEXT: summed from usage rather than scraped off somebody's status bar,
 *     which required a particular status bar and gave nothing without it.
 *   - WHEN: the entry's timestamp, so "how long has this been going" is a
 *     subtraction rather than a guess.
 */
function transcriptReading(claudePid: string): {
  working: boolean | null;
  doing: string | null;
  contextK: number | null;
  lastAt: number | null;
} {
  const none = { working: null, doing: null, contextK: null, lastAt: null };
  try {
    // The transcript directory is named for the session's working directory,
    // which the process itself is the authority on.
    const cwdOut = execFileSync("/usr/sbin/lsof", ["-p", claudePid, "-a", "-d", "cwd", "-Fn"], {
      encoding: "utf8",
      timeout: 4_000,
    });
    const cwd = cwdOut.split("\n").find((l) => l.startsWith("n"))?.slice(1);
    if (!cwd) return none;

    const dir = join(homedir(), ".claude", "projects", cwd.replace(/\//g, "-"));
    if (!existsSync(dir)) return none;

    // The live transcript is the one being written. Newest wins; a session that
    // has not written for a long time will show that in its own timestamp
    // rather than being silently mistaken for a fresh one.
    const newest = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)[0];
    if (!newest) return none;

    // Only the tail is needed and these files reach tens of megabytes.
    const raw = execFileSync("/usr/bin/tail", ["-n", "40", join(dir, newest.f)], {
      encoding: "utf8",
      timeout: 4_000,
      maxBuffer: 8 * 1024 * 1024,
    });

    const msgs: any[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        if (j.type === "assistant" || j.type === "user") msgs.push(j);
      } catch { /* a truncated first line is normal when tailing */ }
    }
    if (!msgs.length) return none;

    const last = msgs[msgs.length - 1];
    const lastAt = last.timestamp ? Date.parse(last.timestamp) : null;

    // A tool call with no result after it is work in flight. A finished
    // assistant message is a turn that has ended.
    const lastAssistant = [...msgs].reverse().find((m) => m.type === "assistant");
    const content = lastAssistant?.message?.content;
    const toolUse = Array.isArray(content) ? content.filter((c: any) => c.type === "tool_use") : [];
    const working = last.type === "assistant" ? toolUse.length > 0 : true;

    const doing = toolUse.length
      ? toolUse.map((t: any) => t.name).join(", ")
      : last.type === "user"
        ? "waiting on a tool result"
        : null;

    const u = lastAssistant?.message?.usage;
    const contextK = u
      ? Math.round(
          ((u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)) / 1000,
        )
      : null;

    return { working, doing, contextK, lastAt };
  } catch {
    return none;
  }
}

/**
 * The status line, assembled from the sources in order of authority.
 *
 * The transcript first, because it is the session's own record: the tool by
 * name, the context from real usage, the time of the last entry. The process
 * table second, for the one thing it settles — whether this is a session at
 * all. The screen last and only for the goal marker, which exists nowhere else.
 *
 * Each line says where it came from. That is not decoration: the pane readings
 * have been wrong for ninety minutes at a stretch, and a reader who cannot tell
 * which number came from the transcript and which was scraped off a status bar
 * cannot tell which one to doubt.
 */
function liveReading(sessionId: string, idleSec: number): string {
  const snap = discoverLiveSessions().find((s) => s.id === sessionId);
  const proc = snap?.tty ? processReading(snap.tty) : { isSession: false, pid: null };

  if (!proc.isSession) {
    return "  no session process on that pane — it is a bare shell, or the session has exited";
  }

  const t = proc.pid ? transcriptReading(proc.pid) : { working: null, doing: null, contextK: null, lastAt: null };
  const out: string[] = [];

  if (t.lastAt !== null) {
    const agoSec = Math.round((Date.now() - t.lastAt) / 1000);
    out.push(
      `  ${t.working ? "working" : "idle"} · last transcript entry ${agoSec < 90 ? `${agoSec}s` : `${Math.round(agoSec / 60)} min`} ago` +
        (t.doing ? ` · ${t.doing}` : ""),
    );
    if (t.contextK !== null) out.push(`  context ${t.contextK}k tokens (from the transcript's own usage, not the status bar)`);
  } else {
    out.push(`  a session is running, but its transcript could not be read — falling back to the screen`);
  }

  const content = readPane(sessionId);
  if (GOAL_ACTIVE.test(content)) {
    out.push(`  goal marker present on screen (a proxy — it lingers after a goal is met)`);
  }
  out.push(`  pane unchanged for ${idleSec}s`);
  return out.join("\n");
}

/**
 * What the session appears to be doing, right now, read fresh.
 *
 * EVERYTHING HERE IS A READING AND IS LABELLED AS ONE. The goal marker is
 * scraped off a status line and has been wrong by ninety minutes; "busy" is
 * inferred from a spinner. The point is not to be authoritative — it is that
 * asking the manager what is going on should not require going and looking, and
 * a reading you know is a reading beats no reading at all.
 */
function paneReading(content: string): string {
  if (!content) return "  the pane could not be read";

  const lines = content.split("\n").map((l) => l.trimEnd());
  const marker = GOAL_ACTIVE.test(content);
  // Two formats appear depending on the status line in use: "81% context used"
  // and "Context: 730K / 1000K". Reading only the first reported nothing at all
  // on a session using the second, which looks exactly like a session with no
  // context reading rather than a reader that cannot see this one.
  const ctx =
    content.match(/(\d{1,3})%\s*context\s*used/i)?.[1] ??
    (() => {
      const m = content.match(/Context:\s*([\d.]+)K\s*\/\s*([\d.]+)K/i);
      return m ? String(Math.round((Number(m[1]) / Number(m[2])) * 100)) : undefined;
    })();
  const busy = /·\s*↓|tokens\)|esc to interrupt|✻|✽/i.test(content);

  /**
   * What it is doing — taken from the STRUCTURE, not from guessing at prose.
   *
   * Three attempts failed before this one, each a filter over "which line looks
   * like real output": a blocklist of chrome (missed two entries), then a
   * word-count test (settled on a "Use /clear to start fresh" tip and reported
   * it as the session's activity for minutes on end). Both were proxies for a
   * question the terminal already answers explicitly.
   *
   * Looking at an actual pane settles it. Tool invocations are marked with a
   * bullet and name what is running. The activity line carries the elapsed time
   * and the tokens drawn. Those are the two facts worth having, they are
   * identifiable by their own markers rather than by their wording, and the tip
   * banner that fooled the last version shares a prefix with real output but
   * carries neither marker.
   */
  const doing = lines.filter((l) => /^\s*⏺/.test(l)).slice(-1)[0]?.replace(/^\s*⏺\s*/, "");
  const activity = content.match(/([A-Za-z]+…)\s*\(([^)]*)\)/);
  const elapsed = activity?.[2];

  const parts = [
    `  looks ${busy ? "busy" : "idle"}`,
    ctx ? `context ${ctx}%` : null,
    // The elapsed time is the number that tells you whether to worry. A session
    // ninety minutes into one turn is either deep in something or stuck, and
    // both are worth knowing; neither is visible from "busy".
    elapsed ? `on this turn ${elapsed.replace(/\s*·\s*/g, ", ")}` : null,
    `goal marker ${marker ? "present" : "absent"}${marker ? " (a proxy — it lingers after a goal is met)" : ""}`,
  ].filter(Boolean);

  return `  ${parts.join(" · ")}${doing ? `\n  doing: ${doing.trim().slice(0, 110)}` : ""}`;
}

/**
 * Collapse text to a single line, for anything about to be TYPED at a prompt.
 *
 * At a prompt a newline is the submit key, so a multi-line objective does not
 * arrive as a long goal — it arrives as a short one, followed by its own
 * remainder as a second, contextless prompt, and the session acts on both. The
 * damage is silent: what was sent looks right in the state file and wrong only
 * on screen.
 *
 * Applied at the point text becomes keystrokes rather than at each point text
 * is set, so it covers every route in — shell heredoc, MCP call, appended
 * text, operator notes — including the ones added later.
 */
export function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

/**
 * When a change to the objective actually reaches the session.
 *
 * Printed because the answer is "not yet", and that has already been misread as
 * the change having failed. Editing an objective types nothing at the session;
 * it changes what the NEXT arming says, and arming waits for the session to
 * stop. Saying so costs one line and removes the whole question.
 */
function landsWhen(m: ManagedSession): string {
  if (m.paused) return "  The manager is paused — nothing is armed until you resume it.";
  return (
    "  This changes what the next arming says; it types nothing now.\n" +
    "  The next arming comes when the session stops — or immediately, with `now`."
  );
}

/**
 * Standing rules: how to work, written once, typed at every arming.
 *
 * WHY THIS IS NOT PART OF THE OBJECTIVE. The objective is re-typed verbatim on
 * every arming, so for a long time it was the only thing that survived — and
 * that made it the only place to put a rule you wanted obeyed all night. The
 * result was an operator hand-writing the same paragraph into every goal, for
 * every project: bound your waits, report when you start an item and when you
 * finish, one commit per item, never send the quit keystroke, bring the app to
 * the front before looking at it, put test files here. Two thirds of a goal
 * that was supposed to say "work through this list".
 *
 * That cost never announced itself. Nothing failed; a person just retyped
 * knowledge the machine already had, and any line they forgot that night was a
 * rule that silently did not apply. So the rules live in one file, apply to
 * every managed session, and the objective goes back to being the task.
 *
 * A FILE RATHER THAN A CLI FIELD, deliberately: these are read and edited far
 * more often than they are written, and a paragraph is easier to revise in an
 * editor than to re-type through a shell. `manage rules` prints the path.
 */
const RULES_FILE = join(homedir(), ".aibroker", "manage-rules.txt");

/**
 * The standing rules, or "" when none are set. Never throws.
 *
 * A file whose first line is `@` followed by a path is a POINTER, and the rules
 * are read from there instead. That exists so the text can have one owner: the
 * same rules belong in the working repository, where they are version
 * controlled, reviewed with the code and read by sessions nobody is managing —
 * and copying them here as well would be two places holding one piece of
 * knowledge, which is a certainty of drift rather than a risk of it. Point at
 * the repository's copy and an edit there is in force at the next arming.
 *
 * One level of indirection only. A pointer to a pointer is a loop waiting to
 * be written, and nothing here is worth that.
 */
export function readStandingRules(path = RULES_FILE): string {
  try {
    if (!existsSync(path)) return "";
    const raw = readFileSync(path, "utf8");
    const target = raw.trim().match(/^@\s*(\S.*)$/m);
    if (target) {
      const p = expandHome(target[1].trim());
      return existsSync(p) ? oneLine(readFileSync(p, "utf8")) : "";
    }
    return oneLine(raw);
  } catch {
    return "";
  }
}

/** Where the rules are read from, for saying so out loud. */
export function standingRulesSource(path = RULES_FILE): string {
  try {
    if (!existsSync(path)) return path;
    const target = readFileSync(path, "utf8").trim().match(/^@\s*(\S.*)$/m);
    return target ? target[1].trim() : foldHome(path);
  } catch {
    return path;
  }
}

/**
 * A path with the home directory folded back to `~`, and the reverse.
 *
 * The pointer is written by a machine and read by a person, and an absolute
 * path carries the account name of whoever ran the command. That is nobody's
 * business in a file that may be copied to another machine, pasted into a bug
 * report or checked in by accident — and the same rules file on two machines
 * should not need two different pointers.
 */
export function foldHome(p: string, home = homedir()): string {
  return p === home ? "~" : p.startsWith(`${home}/`) ? `~/${p.slice(home.length + 1)}` : p;
}

export function expandHome(p: string, home = homedir()): string {
  return p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p;
}

/** Write the standing rules. Passing empty text removes them. */
export function writeStandingRules(text: string, path = RULES_FILE): void {
  const body = text.trim();
  if (!body) {
    try { if (existsSync(path)) unlinkSync(path); } catch { /* nothing to remove */ }
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body.endsWith("\n") ? body : `${body}\n`);
}

/**
 * The most a goal may be, in characters.
 *
 * Measured, not guessed: the receiving prompt answers "Goal condition is
 * limited to 4000 characters" and rejects the whole thing. It cost an evening
 * of armings that reported "typed, but the words never appeared" — true, and
 * silent about the reason. Kept under the real limit so a rules file that grows
 * by a sentence does not walk back over it.
 */
const GOAL_MAX_CHARS = 3800;

/** Sensible default when a shift names no length. Long enough to be worth arming. */
const SHIFT_DEFAULT_HOURS = 8;
/** Nobody should be able to hand over a machine for longer than a day by accident. */
const SHIFT_MAX_HOURS = 24;

/**
 * Read a shift request out of a sentence.
 *
 * Deliberately forgiving about wording and strict about values: the caller is a
 * model turning "you are free to work on the issues for eight hours with your
 * controls, two workers at most" into an action, and the failure to avoid is a
 * shift that silently lasts a different length than the one that was said.
 */
export function parseShift(text: string): { hours: number; visual: boolean; workers: number } {
  const t = text.toLowerCase();
  const h = t.match(/(\d+(?:[.,]\d+)?)\s*(h\b|hours?|hrs?)/);
  const m = t.match(/(\d+)\s*(m\b|minutes?|mins?)/);
  const hours = h ? Number(h[1].replace(",", ".")) : m ? Number(m[1]) / 60 : SHIFT_DEFAULT_HOURS;

  // The screen is withheld unless it was actually offered. A shift that grants
  // the pointer because nobody said not to is the wrong way round.
  const visual = /\b(your controls|with controls|visual|you have the screen|screen is yours)\b/.test(t)
    && !/\b(no screen|without the screen|not visual|headless|screen is mine|i need the screen)\b/.test(t);

  const w = t.match(/(\d+)\s*(workers?|sessions?|in parallel)|(?:max(?:imum)?|up to)\s*(?:of\s*)?(\d+)/);
  const workers = w ? Number(w[1] ?? w[3]) : 1;

  return {
    hours: Math.min(SHIFT_MAX_HOURS, Math.max(0.25, hours)),
    visual,
    workers: Math.min(8, Math.max(1, workers)),
  };
}

/**
 * The standing objective for a shift, written once here instead of by hand
 * every night. It says what to work on and what "done" means; how to work is
 * the standing rules, which ride along with every arming.
 */
export function shiftObjective(): string {
  return oneLine(`
    Work the open issues in this repository's tracker, one at a time, and do not stop.
    Take the oldest open issue you can act on that nobody has claimed. Claim it by
    assigning it to yourself and adding the in-progress label, then RE-READ the issue
    and confirm the claim is yours before doing anything else — if somebody else holds
    it, drop it and take the next.
    Work on a branch named for the issue. Comment on the issue when you start and again
    when you finish, and read a clock for the timestamp.
    Prove the problem is still real before fixing it, and prove the fix on the evidence
    the issue names.
    Commit per item. Merge only when it is a fast-forward and the checks pass; anything
    else gets a label and is left for a person rather than forced.
    When an issue is done, close it, release the claim, and take the next one.
    If there is no issue you can act on, say so and wait rather than inventing work.
  `);
}

/**
 * What a goal is made of, in the order a reader needs it.
 *
 * Task first, because that is what the session is being asked to do. Standing
 * rules second, because they qualify the task rather than replace it. The
 * screen state and any one-shot operator note last, because they are about
 * right now rather than about the job.
 *
 * Exported so the composition can be pinned by a test: this string is typed
 * into a live session, and a mistake in it is a mistake that arrives as
 * keystrokes.
 */
export function composeGoal(
  objective: string,
  rules: string,
  hands: string,
  extra: string,
  rulesPath?: string,
): string {
  const withoutRules = oneLine(`/goal ${objective}${hands}${extra}`);
  if (!rules) return withoutRules;

  const inlined = oneLine(`/goal ${objective} ALWAYS, on every item: ${rules}${hands}${extra}`);
  if (inlined.length <= GOAL_MAX_CHARS) return inlined;

  /*
   * Too long to paste, so point at it instead.
   *
   * The receiving prompt refuses a goal over a few thousand characters, and it
   * refuses the WHOLE goal — so a rules file that grew by a paragraph silently
   * stopped every arming, and the manager reported "typed but the words never
   * appeared", which is true and says nothing about why. The rules were fine;
   * the goal was rejected at the door.
   *
   * Pointing keeps every rule in force. Reading a named file is a discrete act
   * that either happened or did not, which is the kind of instruction sessions
   * actually follow; pasting is only better when it fits.
   */
  const pointer = rulesPath
    ? ` FIRST, before anything else: read ${rulesPath} and follow every rule in it for the whole of this work — they are not optional and they are not summarised here.`
    : "";
  return oneLine(`/goal ${objective}${pointer}${hands}${extra}`);
}

/** The text actually typed at the session. Short goal, context by reference. */
function goalText(m: ManagedSession): string {
  const extra = m.pending.length ? ` OPERATOR, since you were last armed: ${m.pending.join(" ")}` : "";
  // The screen rule has to ride along with EVERY arming. Delivered once, it
  // lasts only until the session next reads a goal — and the goal is what tells
  // it what to do. So a standing rule that is not in the goal is a rule with a
  // lifetime of one turn, and the next arming would send it back to clicking.
  const hands = m.noScreen
    ? " THE OPERATOR HAS THE SCREEN: do no screen or pointer work at all, and do not ask for it. Everything else continues as normal. Where something would need checking on screen, write down what would need checking instead of checking it."
    : "";
  return composeGoal(m.objective, readStandingRules(), hands, extra, standingRulesSource());
}

/**
 * Did it land? Look for the goal's own words in the transcript.
 *
 * NOT "did the content change" — that was the first version and it could not
 * tell a goal that arrived from text stranded unsubmitted in the input line,
 * which is the exact failure it existed to catch. A session prints for a dozen
 * reasons; only the item's own words say the item is there.
 */
function seenInContent(content: string | undefined, fragment: string): boolean {
  if (!content) return false;
  return content.replace(/\s+/g, "").includes(fragment.replace(/\s+/g, ""));
}

function readPane(sessionId: string): string {
  try {
    return readSessionContent(sessionId, 60)?.content ?? "";
  } catch {
    return "";
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function arm(m: ManagedSession, reason: string): Promise<boolean> {
  const text = goalText(m);
  const fragment = m.objective.slice(0, 40);

  /**
   * NEVER TYPE A GOAL INTO A BARE SHELL.
   *
   * This is not hypothetical. A predecessor of this loop went on typing after
   * its session had exited, and the goal landed at a zsh prompt: `/goal` became
   * "no such file or directory" and the sentences after it became commands —
   * `always`, `they`, `the`, all "command not found". Harmless that time
   * entirely by luck, since a goal is prose and prose is mostly not commands.
   * A goal whose wording happened to begin a line with a real command would
   * have run it, in the operator's own shell, with no confirmation.
   *
   * `atPrompt` is exactly the discriminator: it is false for a session running
   * Claude — the foreground process is node whether it is working or idle — and
   * true when the shell itself is waiting for input. So true means the thing we
   * are managing is gone, and the right move is to say so and stop, not to keep
   * typing into whatever is there now.
   */
  const live = readSessionContent(m.sessionId, 5);
  if (!live) {
    note(m, "the session could not be read — not typing anything");
    return false;
  }
  if (live.atPrompt) {
    m.paused = true;
    notify(m, "PAUSED — that pane is at a shell prompt, so the session has exited. Not typing a goal into a shell. `resume` once it is back.");
    return false;
  }

  /**
   * TEXT ON THE INPUT LINE IS NOTED, NEVER OBEYED.
   *
   * This used to refuse to arm while anything sat unsent in the prompt, to
   * avoid running the manager's goal into a half-typed sentence. The intention
   * was right and the mechanism could not support it: the terminal offers a
   * greyed-out SUGGESTION on that same line, accepted with Tab, and in a
   * captured pane no colour survives to tell the two apart. So a suggestion
   * read as somebody mid-sentence, and since a suggestion never finishes being
   * typed, the refusal never lifted. A session sat idle with its goal spent and
   * its work unfinished while every log line reported the guard working.
   *
   * Arming is the one thing that must not be blocked by a signal this weak. A
   * stalled agent is certain and unbounded; running into somebody's half-typed
   * line is occasional and costs one prompt they can retype. So the reading is
   * kept — it is worth having in the record when a goal arrives mangled — and
   * it decides nothing.
   */
  const onLine = promptUnsentText(readPane(m.sessionId));

  if (!typeIntoSession(m.sessionId, text)) {
    note(m, `could not type into the session (${reason}) — will retry`);
    return false;
  }

  // Typed is not sent, and sent is not received.
  for (let i = 0; i < 5; i++) {
    await sleep(2_000);
    if (seenInContent(readPane(m.sessionId), fragment)) {
      m.lastRearmAt = Date.now();
      const carried = m.pending.length;
      m.pending = [];
      armingsSinceReport.set(m.sessionId, (armingsSinceReport.get(m.sessionId) ?? 0) + 1);
      note(
        m,
        `armed: ${reason}${carried ? ` (carrying ${carried} operator instruction${carried > 1 ? "s" : ""})` : ""}` +
          // Recorded because it is the one thing that explains a goal arriving
          // with somebody's half-sentence welded to the front of it.
          (onLine ? ` — the input line held "${onLine.slice(0, 60)}" when this went in` : ""),
      );
      return true;
    }
  }

  notify(m, `typed but the objective's own words never appeared — treating as NOT armed (${reason})`);
  return false;
}

function reasonToArm(m: ManagedSession, content: string, now: number): string | null {
  if (m.paused) return null;

  if (OUT_OF_GOAL.some((re) => re.test(content))) return "the session reported its goal could not be achieved";

  // `now` zeroes the timestamp to force an arming. Without this the age is
  // computed from the epoch and the log says "armed 29779818 min ago", which is
  // true of a number and nonsense about the world — the kind of line that costs
  // somebody ten minutes at three in the morning.
  if (m.lastRearmAt === 0) return "asked to arm now";

  const quietFor = Math.max(0, now - m.lastChangeAt);
  const armedFor = Math.max(0, now - m.lastRearmAt);
  const marker = GOAL_ACTIVE.test(content);

  if (!marker && quietFor > NO_GOAL_GRACE_MS) return `no goal armed (idle ${Math.round(quietFor / 1000)}s)`;

  /**
   * The ceiling — but only over a session that has gone quiet.
   *
   * It exists because the on-screen marker lingers after a goal is met, so a
   * session that finished long ago can look armed forever. What it must not do
   * is fire over a session that is plainly still working, and it did: a
   * six-hour turn crosses the ceiling every forty-five minutes, so the standing
   * objective was re-typed into a session far past the point it describes.
   *
   * That is not the harmless duplicate it first appears. An objective is
   * usually written as a starting instruction — go through all of X, sort them,
   * begin — and delivering it to a session deep in the work reads as an
   * instruction to start over. The manager's own recovery mechanism becomes the
   * thing that undoes the work.
   *
   * A moving pane is direct evidence the session is engaged, and evidence beats
   * the inference drawn from a timer. So the ceiling now needs both: the goal
   * looks old AND nothing is happening.
   */
  if (armedFor > GOAL_MAX_AGE_MS && quietFor > NO_GOAL_GRACE_MS) {
    return `armed ${minutesSince(m.lastRearmAt, now)} with no sign of a new goal, and quiet for ${Math.round(quietFor / 1000)}s — assuming it lapsed`;
  }
  return null;
}

/**
 * A file whose modification time proves the manager loop is still turning.
 *
 * The process being alive is NOT the same claim, and only the weaker one is
 * observable from outside: a wedged loop inside a healthy process satisfies
 * launchd, answers the socket, and manages nothing. Whatever supervises this
 * from outside needs a fact that only a completed tick can produce, so each
 * tick stamps one.
 *
 * Written every tick rather than on change, because "nothing changed" is a
 * normal and frequent outcome here — a heartbeat that stops during quiet
 * periods reports the healthy case as a failure.
 */
const HEARTBEAT_FILE = join(homedir(), ".aibroker", "manage-heartbeat");

function beat(): void {
  try {
    writeFileSync(HEARTBEAT_FILE, String(Date.now()));
  } catch {
    // A heartbeat that cannot be written must not take the manager down with
    // it; the supervisor treats silence as a stall, which is the safe reading.
  }
}

/**
 * Look for blocking modals, but not on every tick.
 *
 * The check costs an AppleScript round trip, and the machine running these
 * sessions is often the machine they are driving — the same contention that
 * makes a pane read slow. Once a minute is far faster than a person noticing,
 * and cheap enough to leave running forever.
 */
const DIALOG_EVERY_TICKS = 3;
let tickCount = 0;

function answerBlockingDialogs(): void {
  if (Object.keys(state).length === 0) return;
  for (const d of listDialogs()) {
    const pressed = answerDialog(d);
    if (pressed) {
      log(`[dialogs] pressed "${pressed}" on ${d.process} — ${d.title}`);
      alertOperator(`A system dialog was blocking work — pressed "${pressed}" on ${d.process}${d.title ? ` (${d.title})` : ""}.`);
    } else {
      // Unrecognised prompt: say so and leave it. A dialog nobody can answer
      // safely still needs somebody told, or it blocks the night in silence.
      alertOperator(
        `A dialog from ${d.process} is on screen and I will not answer it — buttons: ${d.buttons.join(", ") || "none readable"}${d.title ? ` — "${d.title}"` : ""}.`,
      );
    }
  }
}

async function tick(): Promise<void> {
  const now = Date.now();
  let dirty = false;
  beat();

  if (++tickCount % DIALOG_EVERY_TICKS === 0) {
    try {
      answerBlockingDialogs();
    } catch (e) {
      log(`[dialogs] check failed — ${(e as Error).message}`);
    }
  }

  for (const m of Object.values(state)) {
    const content = readPane(m.sessionId);
    if (!content) {
      // A session that cannot be read is not necessarily gone; say so once per
      // tick rather than dropping it, because dropping it silently is how a
      // manager stops managing without anybody noticing.
      continue;
    }

    const h = hash(content);
    if (h !== m.lastHash) {
      m.lastHash = h;
      m.lastChangeAt = now;
      dirty = true;
    }

    /**
     * THE BACKSTOP: a managed session whose screen has not moved in a long time.
     *
     * Every specific fault above is a fault somebody already thought of. This
     * one is for the faults nobody has thought of yet, and it is deliberately
     * ignorant of causes: it does not care whether a rollover misfired, a goal
     * failed to land, a clear ate the prompt, or something new. It knows only
     * that a session under management has shown no sign of life for a long
     * time, which is never a state worth preserving.
     *
     * Arming is the response because arming is the cheap direction to be wrong
     * in. Against a genuinely busy session it queues one prompt behind a long
     * turn, costing nothing; against a dead one it is the whole recovery. The
     * asymmetry is the argument — and it is why this fires on a signal as crude
     * as "nothing changed", which no more precise test would improve on.
     */
    if (!m.paused && !m.handoverAskedAt && now - m.lastChangeAt > STUCK_AFTER_MS) {
      notify(
        m,
        `nothing has moved on that screen for ${minutesSince(m.lastChangeAt, now)} — arming, because a managed session is never meant to be still this long`,
      );
      // Counted as a change so a session that stays stuck is not re-armed every
      // tick: this is a recovery, and a recovery that repeats is a loop.
      m.lastChangeAt = now;
      m.lastRearmAt = 0;
      dirty = true;
    }

    /**
     * A timed screen decision reverts itself.
     *
     * Checked before anything else in the tick, because the whole value is that
     * it happens without a person: "hands on for eight hours" has to hand the
     * screen back at the eighth hour whether or not anybody is awake to ask.
     */
    /**
     * The end of a shift, which is a stand-down and not a kill.
     *
     * Arming stops; nothing is interrupted. A session mid-turn finishes it, and
     * the objective stays so that `resume` picks the work up rather than
     * starting it over. Announced once, because a fleet that quietly stopped
     * looks exactly like a fleet that is still going.
     */
    if (m.shift && now >= m.shift.until && !m.shift.endReported) {
      m.shift.endReported = true;
      m.paused = true;
      notify(m, `shift over after ${Math.round((now - m.shift.startedAt) / 3_600_000)}h — no longer arming; the objective is kept, \`resume\` continues it`);
      dirty = true;
    }

    if (m.handsUntil && now >= m.handsUntil) {
      const wasOff = m.handsWas === true;
      delete m.handsUntil;
      delete m.handsWas;
      m.noScreen = !wasOff;
      typeIntoSession(
        m.sessionId,
        m.noScreen
          ? "The time you had the screen for is up — my controls. The operator may be back at the machine, so stop screen and pointer work now, write down how far you got and what still needs checking on screen, and carry on with everything that does not need it."
          : "your controls. The screen is yours again — the operator's hold has expired. You may resume visual work where your notes left it.",
      );
      notify(m, m.noScreen ? "timed grant expired — screen work stopped" : "timed hold expired — screen work permitted again");
      dirty = true;
    }

    /**
     * A clear that was typed earlier, landing late.
     *
     * Kept OUTSIDE the rollover block because that block is no longer running
     * by the time this usually happens: the rollover gave up waiting, the
     * session stayed in its turn for another half hour, and the clear finally
     * executed with nothing left watching for it. Without this, the pending
     * flag would never be lifted and the session could never roll over again —
     * a safety catch that, having done its job once, quietly became a lock.
     */
    if (m.clearPendingSince && !m.clearTypedAt) {
      if (CLEARED_BANNER.test(content) && !QUEUED_INPUT.test(content)) {
        notify(m, `the clear typed ${minutesSince(m.clearPendingSince, now)} ago has landed — arming the fresh session`);
        clearLanded(m);
        dirty = true;
      }
    }

    /**
     * ROLLING OVER BEFORE THE WALL.
     *
     * A session that fills its context does not degrade gracefully; it starts
     * losing the thread while still appearing to work, which is the worst of
     * both — it is producing output nobody should trust. So at a threshold it
     * is asked to write down what it knows, and only once that is ON DISK is it
     * cleared and re-armed.
     *
     * THE ORDER IS THE WHOLE DESIGN, and the previous attempt at this got it
     * wrong: it cleared first and deleted the very file it was meant to
     * preserve. Nothing here deletes anything, the handover is verified by
     * reading the file back rather than by the session saying it wrote one, and
     * a session that does not produce a handover is left alone rather than
     * cleared. Losing a cycle is recoverable; clearing an unrecorded session is
     * not.
     */
    if (!m.paused && m.handoverAskedAt) {
      const wrote = handoverChanged(m);
      if (wrote && !m.clearAfterHandover) {
        /**
         * HANDOVER WRITTEN, AND THAT IS THE WHOLE JOB.
         *
         * Clearing used to follow automatically and it was the wrong half of
         * the idea. A clear cannot execute while a turn is running, and a
         * session working towards a goal does not end its turn — so the clear
         * waited in the input queue, and every fresh attempt added another,
         * until a queue of them stood ready to fire in sequence against
         * whatever sessions happened to exist by then.
         *
         * Meanwhile the thing it was protecting against turned out to be
         * handled: the terminal compacts by itself at the limit and the
         * session carries on working through it. What compaction costs is
         * detail, and detail is exactly what the handover has already written
         * to disk. So the valuable half runs and the dangerous half does not,
         * unless somebody asks for it by name.
         */
        notify(m, "handover written — leaving the session to compact on its own rather than clearing it");
        m.handoverDoneAt = now;
        m.handoverDoneK = contextK(m) ?? undefined;
        delete m.handoverAskedAt;
        delete m.handoverWas;
        delete m.handoverAskedPath;
        dirty = true;
        continue;
      }
      if (wrote) {
        /**
         * A CLEAR CANNOT LAND WHILE A GOAL IS ARMED.
         *
         * Observed rather than reasoned: the goal enforcement blocks the turn
         * from ending, the terminal will not read queued input until the turn
         * ends, and so `/clear` sits in the input line indefinitely while the
         * session repeats that it has nothing to add. The blocker does give up
         * after several attempts, which is why this waits rather than retries.
         *
         * TYPING IT AGAIN IS THE WRONG MOVE and the tempting one: a second
         * `/clear` queues behind the first and fires afterwards, against the
         * FRESH context — wiping the very session that just started. So this
         * types once, then watches the context figure, which is the artefact.
         */
        if (!m.clearTypedAt) {
          if (m.clearPendingSince && now - m.clearPendingSince < CLEAR_PENDING_MAX_MS) {
            // An earlier clear is still unaccounted for. Typing another would
            // put two in a queue that fires against two different sessions.
            notify(
              m,
              `a clear typed ${minutesSince(m.clearPendingSince, now)} ago has still not landed — not typing another, and not rolling over again until it does`,
            );
            endRollover(m);
            dirty = true;
            continue;
          }
          notify(m, "handover written — asking it to clear");
          typeIntoSession(m.sessionId, "/clear");
          m.clearTypedAt = now;
          m.clearPendingSince = now;
          m.contextAtClear = contextK(m) ?? undefined;
          dirty = true;
          continue;
        }

        /**
         * DID THE CLEAR LAND? ASK THE SCREEN, NOT ONLY THE NUMBER.
         *
         * The context figure was the sole test and it failed in the one way
         * that mattered: `contextK` can return null — the pane's pid, and
         * thence its transcript, is not always resolvable — and a null at the
         * moment the clear was typed leaves `contextAtClear` undefined, which
         * makes the drop test unsatisfiable FOREVER AFTER. Not flaky: a
         * rollover begun during that blind moment could never be seen to
         * finish, however cleanly it did.
         *
         * So the pane corroborates, via the startup banner — see
         * CLEARED_BANNER for why that particular mark and not the more obvious
         * one. Either witness alone is enough; neither is trusted to be
         * available.
         */
        /**
         * THE BANNER IS THE PROOF. THE NUMBER IS ONLY THE DETAIL.
         *
         * A falling context figure was the original test and it cannot do the
         * job, because a clear is not the only thing that empties a context:
         * the terminal compacts on its own near the limit, and compaction
         * produces exactly the same collapse in the same figure. Believing it
         * would mean declaring a clear that never happened, dropping the guard
         * that stops another being typed, and arming a session that is still
         * mid-turn with clears queued behind it.
         *
         * Compaction redraws no banner. Only starting and clearing do, and
         * inside this window only clearing is possible — so the banner alone
         * decides, and the number is reported beside it because it is useful
         * to read, not because it is being trusted.
         */
        const nowK = contextK(m);
        const fell = m.contextAtClear !== undefined && nowK !== null && nowK < m.contextAtClear / 2;
        if (CLEARED_BANNER.test(content) && !QUEUED_INPUT.test(content)) {
          notify(
            m,
            fell
              ? `cleared — fresh session on the pane, context fell from ${m.contextAtClear}k to ${nowK}k; re-arming`
              : "cleared — the pane is showing a fresh session; re-arming",
          );
          clearLanded(m);
          dirty = true;
          continue;
        }

        if (now - m.clearTypedAt > HANDOVER_GRACE_MS) {
          /**
           * GIVING UP ON THE ROLLOVER IS NOT GIVING UP ON THE SESSION.
           *
           * This is where eight hours went. The branch was right to refuse a
           * SECOND clear — that would fire against a fresh context and wipe
           * it — but it also declined to arm, and those are different acts. It
           * then left `lastRearmAt` untouched, so ordinary arming stayed
           * blocked behind the stale on-screen goal marker until the 45-minute
           * ceiling expired. A cleared session sat at an empty prompt for the
           * whole of it, reading as "working" the entire time.
           *
           * Arming is safe under BOTH readings of an ambiguous outcome. If the
           * clear did land, arming is exactly what the fresh session needs. If
           * it did not, arming re-states the objective to a session that still
           * has its context, which costs one prompt. There is no reading in
           * which doing nothing is the better move, so this no longer does
           * nothing.
           */
          notify(
            m,
            "the clear was typed and could not be confirmed — NOT typing a second one, " +
              "but arming anyway: an armed session is safe whether or not the clear landed",
          );
          endRollover(m);
          dirty = true;
        }
        continue;
      }
      if (now - m.handoverAskedAt > HANDOVER_GRACE_MS) {
        notify(m, "asked for a handover and did not get one — NOT clearing, the session keeps its context");
        delete m.handoverAskedAt;
        delete m.handoverWas;
        dirty = true;
      }
      // Still waiting. Do not arm anything on top of a session that is writing.
      continue;
    }

    // No new rollover while a clear is still unaccounted for. Context stays
    // high precisely because the clear has not landed, so without this the
    // threshold re-qualifies the session every tick and the rollover machinery
    // runs in a circle, each lap adding another clear to the queue.
    if (!m.paused && !m.handoverAskedAt && !m.clearPendingSince && m.handoverFile) {
      // The pane is resolved here rather than carried in from elsewhere in the
      // tick, so this block does not depend on the order of what precedes it.
      const tty = m.tty ?? snapshotTty(m.sessionId);
      const pid = tty ? processReading(tty).pid : null;
      const t = pid ? transcriptReading(pid) : null;
      const used = t?.contextK ?? null;

      /**
       * TWO WAYS TO BECOME DUE, because a handover goes out of date two ways.
       *
       * By the clock, which is the ordinary case. And by work done since the
       * last one, which is the case that mattered and was missing: a session
       * asked at the threshold keeps working to the wall, and everything it
       * learns in that stretch is absent from the file precisely when
       * compaction discards it. The second trigger keeps the document current
       * with the work rather than with the hour.
       */
      const sinceLast = now - (m.handoverDoneAt ?? 0);
      const grownBy = used !== null && m.handoverDoneK !== undefined ? used - m.handoverDoneK : null;
      const dueByTime = sinceLast > HANDOVER_REASK_MS;
      const dueByWork = grownBy !== null && grownBy >= HANDOVER_REASK_K && sinceLast > HANDOVER_MIN_GAP_MS;

      // 1M is the window these sessions run in; treat anything else as unknown
      // rather than guessing, because a wrong denominator rolls over a session
      // that had plenty of room left.
      if ((dueByTime || dueByWork) && used !== null && used / 1000 >= HANDOVER_AT) {
        const askedPath = resolveHandoverPath(m.handoverFile);
        m.handoverAskedAt = now;
        m.handoverAskedPath = askedPath;
        m.handoverWas = fileFingerprint(askedPath);
        // A dated handover starts empty each day, and an empty one is worse
        // than none: it reads as authoritative and says nothing. So the
        // instruction carries the rule for that case rather than assuming the
        // session will think of it at the moment it is running out of room.
        const carry = existsSync(askedPath)
          ? ""
          : `That file does not exist yet — start it by carrying forward from the most recent handover beside it whatever still matters, especially anything written nowhere else. `;
        // A top-up reads differently from a first request: the session has
        // already written one and needs to know this is about the work SINCE,
        // not a repeat it can satisfy by confirming the file is still there.
        const topUp = dueByWork && !dueByTime && grownBy !== null;
        typeIntoSession(
          m.sessionId,
          (topUp
            ? `Bring your handover up to date — you are at ${used}k tokens, ${grownBy}k of work since you last wrote it, and the terminal will compact before long. Everything you have learned in that stretch is currently written nowhere but this context, which is the part compaction takes. `
            : `Write your handover now — you are at ${used}k tokens and the terminal will compact before long. `) +
            `Update ${askedPath}. ${carry}Three things: where the current item stands, what you would do next and why, ` +
            `and — the irreplaceable part — anything you know that is written nowhere else. Commit it. ` +
            (m.clearAfterHandover
              ? `You will be cleared once that file has changed on disk, and not before.`
              : `Then carry straight on with the work; you are not being cleared. And keep that file current as you go — anything you work out after writing it is at risk until it is on disk.`),
        );
        notify(
          m,
          topUp
            ? `at ${used}k tokens, ${grownBy}k of new work since the last one — asked to bring the handover up to date`
            : `at ${used}k tokens — asked for a handover${m.clearAfterHandover ? " before rolling over" : " before it compacts"}`,
        );
        dirty = true;
        continue;
      }
    }

    if (now - m.lastRearmAt < REARM_COOLDOWN_MS) continue;

    const reason = reasonToArm(m, content, now);
    if (!reason) continue;

    /**
     * A GOAL THAT CANNOT BE CONFIRMED IS NOT RETRIED FOREVER.
     *
     * Arming types the objective and then reads it back off the pane; when the
     * read fails the attempt is honestly recorded as not armed, and the
     * arm-now sentinel stays set so the next tick tries again. That is right
     * once and wrong indefinitely: a session busy in a long turn queues the
     * text instead of showing it, so the read keeps failing while every
     * attempt adds another copy of the goal to its input queue. Three of them
     * waiting to fire in sequence is the same fault the clears had, reached by
     * a different road.
     *
     * So the retries are counted and stopped. Backing off restores the
     * ordinary rules — the session is still managed, and the next genuine
     * lapse arms it — and the operator is told, because a manager that has
     * given up on delivering a goal is the one thing it must never do quietly.
     */
    const armed = await arm(m, reason);
    dirty = true;
    if (armed) {
      m.armFails = 0;
      continue;
    }
    m.armFails = (m.armFails ?? 0) + 1;
    if (m.armFails >= ARM_ATTEMPTS) {
      m.armFails = 0;
      m.lastRearmAt = now;
      notify(
        m,
        `typed the goal ${ARM_ATTEMPTS} times without being able to confirm it landed — stopping, so it is not queued again. ` +
          `The session is usually mid-turn when this happens; it stays managed and will arm at the next real lapse.`,
      );
    }
  }

  if (dirty) saveState(state);
  // Last, so the report describes the state this tick left behind rather than
  // the one it found.
  reportIfDue(now);
}

export function startManagerLoop(): void {
  if (timer) return;
  state = loadState();
  const n = Object.keys(state).length;
  if (n) log(`[manage] resuming ${n} managed session${n > 1 ? "s" : ""}`);
  timer = setInterval(() => {
    void tick().catch((e) => log(`[manage] tick failed — ${(e as Error).message}`));
  }, TICK_MS);
  timer.unref?.();
}

export interface ManageResult {
  ok: boolean;
  message: string;
  managed?: boolean;
}

/**
 * The whole operator surface, in one call.
 *
 * `/manage <objective>`  start managing this session with that objective
 * `/manage <message>`    once running, an instruction carried into the next arming
 * `/manage`              what is it doing
 * `/manage off`          stop
 * `/manage pause|resume` stop arming without forgetting the objective
 * `/manage now`          arm immediately, whatever the signals say
 */
export async function handleManage(sessionIdOrName: string, rawArg: string): Promise<ManageResult> {
  const arg = (rawArg ?? "").trim();

  /**
   * `machine/session` is managed by that machine's own hub.
   *
   * Not proxied, delegated. The remote hub owns its panes, reads its own
   * transcripts and types into its own terminals; a manager here would be
   * guessing about all three across a network. So the objective is handed over
   * and lives there, which is also what makes it survive this machine being
   * closed — the developer keeps working when the manager goes home, which is
   * the entire point of giving them their own computer.
   */
  {
    const { forwardToPeer } = await import("./peer-handlers.js");
    const forwarded = await forwardToPeer(sessionIdOrName, "manage", { arg });
    if (forwarded) {
      return forwarded.ok
        ? { ok: true, message: forwarded.result?.message ?? "done", managed: forwarded.result?.managed }
        : { ok: false, message: forwarded.error ?? "the peer refused it" };
    }
  }

  const resolved = resolveSession(sessionIdOrName);
  if (!resolved) return { ok: false, message: `no live session matches "${sessionIdOrName}"` };

  const { sessionId, name } = resolved;
  const existing = state[sessionId];
  const word = arg.toLowerCase();

  // help — the grammar, from the thing that implements it.
  //
  // Written here rather than in the CLI and the hook and the tool description,
  // because three copies of one list is how they end up disagreeing. Everything
  // that answers `manage` reads this same text.
  if (word === "help" || word === "?" || word === "--help" || word === "-h") {
    return {
      ok: true,
      managed: !!existing,
      message:
        `manage — keep a session working on a standing objective.\n\n` +
        `  <objective>   start managing, or once running, an instruction carried\n` +
        `                into the next arming ("do the tests before the docs")\n` +
        `  status        what the session looks like right now, and what the\n` +
        `                manager has done. Also: state, what, info, show\n` +
        `  hands off     the operator needs the screen: stops visual work at once,\n` +
        `                keeps everything else going, and says why\n` +
        `  hands on      give the screen back\n` +
        `  hands on|off for 8 hours | 30m\n` +
        `                same, but it reverts by itself — a permission that ends\n` +
        `                only when somebody remembers outlives its reason\n` +
        `  handover <path> [clear]\n` +
        `                where this session writes what it knows. At 82% context it\n` +
        `                is asked to update that file, then carries on — the terminal\n` +
        `                compacts by itself and the file is what survives it. Add\n` +
        `                "clear" to also clear the session (queues, in a long turn)\n` +
        `  set <text>    REPLACE the standing objective. Plain text on a running\n` +
        `                manager is a one-shot note; this changes what it re-arms\n` +
        `  add <text>    EXTEND the standing objective. Say it to the session\n` +
        `                instead and the next arming forgets it\n` +
        `  rules [text|from <path>|clear]\n` +
        `                HOW to work, as opposed to what to work on: typed into every\n` +
        `                arming of every managed session, so it is written once rather\n` +
        `                than into each objective by hand. No argument shows them\n` +
        `  shift [8h] [your controls] [2 workers]\n` +
        `                a bounded stretch of autonomous work on the tracker's open\n` +
        `                issues: objective, screen decision, expiry and arming in one\n` +
        `                sentence. \`shift off\` stands it down without killing it\n` +
        `  now           arm immediately, whatever the signals say\n` +
        `  pause         stop arming, keep the objective\n` +
        `  resume        start arming again\n` +
        `  off           stop managing entirely\n` +
        `  help          this\n\n` +
        `Three ways in:\n` +
        `  aibroker manage <session> …   any shell. Works while the session is busy.\n` +
        `  /btw manage …                 inside the session; answers by notification,\n` +
        `                                because a busy session cannot print a reply.\n` +
        `  /btw manage <in words>        anything not in the list above goes to the\n` +
        `                                model, which reads it and calls the tool.\n\n` +
        `${existing ? `Currently managing ${name}: ${existing.objective}` : `${name} is not being managed.`}`,
    };
  }

  /**
   * rules — the standing "how to work" text, shared by every managed session.
   *
   * Answers on its own rather than through a session, because the rules are not
   * a property of one: setting them from whichever pane happens to be to hand
   * must not depend on which session that is.
   */
  const rulesMatch = arg.match(/^rules(?:\s+([\s\S]+))?$/i);
  if (rulesMatch) {
    const rest = (rulesMatch[1] ?? "").trim();
    if (!rest || rest.toLowerCase() === "show") {
      const current = readStandingRules();
      return {
        ok: true,
        managed: !!existing,
        message: current
          ? `standing rules, typed into every arming of every managed session:\n\n  ${current}\n\n` +
            `  read from ${standingRulesSource()} — edit them there.\n` +
            `  \`manage rules from <path>\` points at a file the working repository owns.\n` +
            `  \`manage rules clear\` removes them.`
          : `no standing rules set.\n\n` +
            `  These are the lines you would otherwise write into every objective by hand —\n` +
            `  how to work, as opposed to what to work on. They are typed at every arming, so\n` +
            `  they survive a compaction, and they are shared by every managed session.\n\n` +
            `  Set them with \`manage rules <text>\`, write ${RULES_FILE} directly, or\n` +
            `  \`manage rules from <path>\` to let the working repository own the text.`,
      };
    }
    const from = rest.match(/^from\s+(\S.*)$/i);
    if (from) {
      const target = foldHome(expandHome(from[1].trim()));
      writeStandingRules(`@${target}`);
      const got = readStandingRules();
      return {
        ok: true,
        managed: !!existing,
        message: got
          ? `standing rules now read from ${target} — edit them there and the next arming has them.\n  ${got.slice(0, 160)}${got.length > 160 ? "…" : ""}`
          : `pointed at ${target}, but nothing readable is there yet. The pointer stays; armings carry no rules until that file exists.`,
      };
    }
    if (rest.toLowerCase() === "clear") {
      writeStandingRules("");
      return { ok: true, managed: !!existing, message: "standing rules cleared — objectives now carry only themselves." };
    }
    writeStandingRules(rest);
    return {
      ok: true,
      managed: !!existing,
      message:
        `standing rules set — they go into every arming, of every managed session.\n  ${oneLine(rest).slice(0, 200)}${rest.length > 200 ? "…" : ""}\n` +
        `  Stored at ${RULES_FILE}.`,
    };
  }

  /**
   * shift — a bounded stretch of autonomous work, set up in one sentence.
   *
   * Everything the operator used to type by hand: the objective, the screen
   * decision and its expiry, the arming, and how long it all lasts.
   */
  /*
   * Only the word "shift", and only leading.
   *
   * The first version also accepted "go" and "work", which read well and was
   * wrong: "work through the open items first" is how half of all objectives
   * begin, and it would have been swallowed as a shift request — silently
   * replacing what the operator typed with the issue-driven objective. A verb
   * that can be mistaken for the start of a sentence is not a verb.
   */
  const shiftMatch = arg.match(/^shift\b\s*([\s\S]*)$/i);
  if (shiftMatch) {
    const rest = (shiftMatch[1] ?? "").trim();
    if (!existing) {
      return { ok: false, message: `${name} is not being managed yet. Start with an objective first, or use \`manage ${name} <objective>\`.` };
    }
    if (/^(off|stop|end|stand down)\b/i.test(rest)) {
      const had = existing.shift;
      delete existing.shift;
      existing.paused = true;
      note(existing, "shift ended by the operator — no longer arming");
      saveState(state);
      return {
        ok: true,
        managed: true,
        message: had
          ? `shift ended. ${name} keeps its objective and is no longer re-armed; whatever it is doing now runs to its natural stop.\n  \`manage ${name} resume\` picks it up again.`
          : `${name} had no shift running. It is paused now either way.`,
      };
    }

    const { hours, visual, workers } = parseShift(rest);
    const until = Date.now() + hours * 3_600_000;
    existing.objective = shiftObjective();
    existing.pending = [];
    existing.paused = false;
    existing.noScreen = !visual;
    existing.handsUntil = until;
    existing.handsWas = !visual;
    existing.shift = { until, workers, visual, startedAt: Date.now() };
    // Arm on the next tick rather than typing over whatever is on screen now.
    existing.lastRearmAt = 0;
    note(existing, `shift started: ${hours}h, ${visual ? "screen granted" : "no screen"}, up to ${workers} worker(s)`);
    saveState(state);

    const ends = new Date(until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return {
      ok: true,
      managed: true,
      message:
        `${name} is on shift for ${hours} hour(s), until ${ends}.\n` +
        `  ${visual ? "The screen is its own until then, and reverts by itself." : "No screen work — the operator has the machine."}\n` +
        `  Objective set to the tracker's open issues; the standing rules ride along with every arming.\n` +
        (workers > 1
          ? `  Asked for ${workers} workers. Only one runs today — worktrees and the claim protocol are designed but not built, and a second worker without them would share a checkout with the first.\n`
          : "") +
        `  It arms on the next tick. \`manage ${name} shift off\` stands it down without killing it.`,
    };
  }

  if (word === "off" || word === "stop") {
    if (!existing) return { ok: true, message: `${name} was not being managed`, managed: false };
    delete state[sessionId];
    saveState(state);
    log(`[manage:${name}] stopped by the operator`);
    return { ok: true, message: `stopped managing ${name}`, managed: false };
  }

  // "status" is what a person actually types when they want the status, and the
  // first version took it as an objective and started managing the session with
  // the objective "status". Anything that reads as a question about state is a
  // question about state; only text that is not one of these becomes an
  // objective. Getting this wrong is silent and sets the session working on a
  // word.
  const ASKING = new Set(["status", "state", "what", "what?", "?", "info", "show"]);
  if (!arg || ASKING.has(word)) {
    if (!existing) return { ok: true, message: `${name} is not being managed. /manage <objective> to start.`, managed: false };
    const last = existing.history.slice(-4).map((h) => `  ${h.at.slice(11)} ${h.what}`).join("\n");
    // 0 is the sentinel for "arm on the next tick", not a timestamp. Subtracting
    // from it prints the age of the epoch — a seven-digit number, in the one
    // window where somebody is watching this line to see whether an arming
    // happened. Say what the state actually is instead.
    const armed =
      existing.lastRearmAt === 0
        ? "arming on the next tick"
        : `last armed ${minutesSince(existing.lastRearmAt, Date.now())} ago`;
    const idle = Math.round((Date.now() - existing.lastChangeAt) / 1000);
    // Two separate things, kept separate: what the manager has DONE, and what
    // the session appears to be doing. Running them together is how a record of
    // one gets read as evidence about the other.
    return {
      ok: true,
      managed: true,
      message:
        `managing ${name}${existing.paused ? " (paused)" : ""}\n` +
        `objective: ${existing.objective}\n` +
        `\nright now:\n` +
        liveReading(sessionId, idle) +
        `\n\nthe manager: ${armed}` +
        (existing.pending.length ? `, ${existing.pending.length} instruction(s) waiting to go out` : "") +
        (last ? `\n${last}` : ""),
    };
  }

  /**
   * set — REPLACE the standing objective, rather than adding a note to it.
   *
   * Without this there was no way to correct one. Free text on a running
   * manager becomes a one-shot instruction, so a mistake in the objective could
   * only be answered by a note that itself expires — and the objective is
   * re-read on EVERY arming, so anything wrong in it is re-asserted forever
   * rather than misleading once. That is the difference between an objective
   * and a message, and it is why this needs its own verb.
   */
  const setMatch = arg.match(/^(?:set|objective|replace)\s+([\s\S]+)$/i);
  if (setMatch && existing) {
    const before = existing.objective;
    existing.objective = setMatch[1].trim();
    // Notes written against the old objective may not make sense against the
    // new one; say so rather than silently carrying them over.
    const dropped = existing.pending.length;
    existing.pending = [];
    note(existing, `objective replaced${dropped ? `, ${dropped} pending instruction(s) dropped with it` : ""}`);
    saveState(state);
    return {
      ok: true,
      managed: true,
      message:
        `objective replaced for ${name}.\n  was: ${before.slice(0, 80)}${before.length > 80 ? "…" : ""}\n  now: ${existing.objective.slice(0, 80)}${existing.objective.length > 80 ? "…" : ""}\n` +
        landsWhen(existing) +
        (dropped ? `\n  ${dropped} pending instruction(s) dropped — they were written against the old objective.` : ""),
    };
  }

  /**
   * add — EXTEND the standing objective instead of replacing it.
   *
   * The alternative is to say it to the session directly, and for anything whose
   * result lands on disk that works fine. It fails for anything meant to steer
   * the work, and fails silently: the objective is re-typed at every arming, so
   * the session is periodically returned to a description of the job that never
   * mentioned the thing you added. Rewriting the whole objective to append one
   * sentence is the workaround this exists to remove, and a costly one, since
   * retyping something long is how a constraint gets dropped by accident.
   *
   * Joined with a space rather than a paragraph break because this text is typed
   * at a prompt, where a newline submits — see goalText.
   */
  const addMatch = arg.match(/^(?:add|also|append|extend)\s+([\s\S]+)$/i);
  if (addMatch && existing) {
    const extra = addMatch[1].trim();
    existing.objective = `${existing.objective} Also: ${extra}`;
    note(existing, `objective extended: ${extra.slice(0, 80)}`);
    saveState(state);
    return {
      ok: true,
      managed: true,
      message:
        `objective extended for ${name}.\n  added: ${extra}\n` +
        landsWhen(existing),
    };
  }

  /**
   * hands off / hands on — take the screen back without stopping the work.
   *
   * `pause` is the wrong tool for this: it stops the manager, and what is
   * wanted is the opposite — the session keeps working, it just stops touching
   * the screen. A session driving the pointer is the one thing that cannot
   * share a machine with its operator.
   *
   * DELIVERY IS THE HARD PART, and an instruction carried into the next arming
   * is useless here: the next arming may be twenty minutes away and the pointer
   * is moving now. Two things happen instead, and neither waits for a goal.
   *
   * First, the message is typed into the session directly, so it lands at the
   * next tool-call boundary — seconds, for a session that is clicking.
   *
   * Second, it opens with the exact phrase the screen-control tool's own hook
   * watches for. That revokes control at the TOOL, so the next click fails with
   * an error explaining why, rather than depending on the session having read
   * and obeyed a sentence. Enforced beats cooperative when the cost of it being
   * ignored is the operator losing their pointer mid-sentence.
   */
  const handsMatch = arg.match(/^hands?\s+(off|on)\b\s*(.*)$/i);
  if (handsMatch || word === "nogui" || word === "gui") {
    const off = handsMatch ? /off/i.test(handsMatch[1]) : word === "nogui";
    if (!existing) return { ok: false, message: `${name} is not being managed` };

    /**
     * A DURATION, because the useful case is bounded in both directions.
     *
     * "hands on for eight hours" is the overnight grant: it may drive the screen
     * while nobody is at the machine, and it gives the screen BACK before
     * somebody sits down — without that person having to remember to revoke it.
     * "hands off for thirty minutes" is the mirror: take the machine, and have
     * visual work resume by itself rather than staying stopped because nobody
     * said the word.
     *
     * Both matter for the same reason: a permission that only ends when a person
     * remembers to end it is a permission that outlives its reason.
     */
    const dur = (handsMatch?.[2] ?? "").match(/(?:for\s+)?(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes)\b/i);
    if (dur) {
      const n = Number(dur[1]);
      const unit = dur[2].toLowerCase();
      const ms = /^h/.test(unit) ? n * 3_600_000 : n * 60_000;
      existing.handsUntil = Date.now() + ms;
      existing.handsWas = off;
    } else {
      delete existing.handsUntil;
      delete existing.handsWas;
    }

    existing.noScreen = off;
    if (off) {
      // The reason comes FIRST, and the phrase is inside a sentence rather than
      // barked on its own. "my controls" alone revokes the tool and explains
      // nothing — a session that has just lost the pointer mid-task, with no
      // reason given, will either guess or stop, and both are worse than being
      // told. What it needs is: why, what to stop, what to leave behind, what to
      // do instead, and when this ends.
      const msg =
        "THE OPERATOR NEEDS THE SCREEN — my controls. This is not a fault and not a criticism of what you were doing; " +
        "they have come back to the machine and cannot share a pointer with you. " +
        "So: stop all screen and pointer work now, mid-task if necessary. " +
        "Write into your notes exactly how far you got and what still needs verifying on screen, in enough detail that somebody can resume it cold — that record is the only thing being asked of the work you are abandoning. " +
        "Then KEEP WORKING on everything that does not need the screen: reading code, diagnosing, writing, tests, notes. There is plenty of that. " +
        "Do not stop and do not wait. The screen comes back to you when you are told the controls are yours again.";
      typeIntoSession(sessionId, msg);
      note(existing, "hands off — screen work stopped, non-visual work continues");
    } else {
      typeIntoSession(sessionId, "your controls. The screen is yours again — you may resume visual work where your notes left it.");
      note(existing, "hands on — screen work permitted again");
    }
    saveState(state);
    return {
      ok: true,
      managed: true,
      message:
        (off
          ? `${name}: screen work stopped and the message is on its way. It keeps working on everything that needs no screen, and every arming carries the same rule.`
          : `${name}: screen work permitted again.`) +
        (existing.handsUntil
          ? `\n  reverts by itself at ${new Date(existing.handsUntil).toLocaleTimeString("de-DE")} — no need to remember.`
          : `\n  stays this way until you say otherwise.`),
    };
  }

  /**
   * handover <path> — where this session writes what it knows.
   *
   * Rollover is OFF until this is set, deliberately. Clearing a session that has
   * nowhere to write is destroying it, and a default guess at a path would be a
   * guess about somebody's project conventions with an unrecoverable failure
   * mode. Naming the file is the act of consenting to be rolled over.
   */
  /**
   * `handover <path> [clear]` — where to write, and whether to clear after.
   *
   * The trailing word is what makes clearing opt-in. It reads as an
   * afterthought and is the opposite: without it this asks a session to record
   * what it knows and then leaves it alone, which is the behaviour that has
   * actually held up. With it, the session is also cleared — worth having for a
   * session that idles between items, and worth refusing to do by default for
   * one that works in long turns, where the clear cannot execute and merely
   * queues.
   */
  const handoverMatch = arg.match(/^handover\s+(.+)$/i);
  if (handoverMatch && existing) {
    const rest = handoverMatch[1].trim();
    const wantsClear = /\s+clear$/i.test(rest);
    const path = rest.replace(/\s+clear$/i, "").trim();
    const previous = existing.handoverFile;
    existing.handoverFile = path;
    existing.clearAfterHandover = wantsClear;
    delete existing.handoverDoneAt;
    delete existing.handoverDoneK;
    delete existing.handoverAskedPath;
    const resolved = resolveHandoverPath(path);

    /**
     * Tell the session its target moved, now rather than at the next threshold.
     *
     * A session that maintains its handover as it works — which is the habit
     * worth having — keeps writing to whatever path it last heard. Left
     * uninformed it goes on updating a file nobody will read again, and the
     * change looks like it worked right up until the moment somebody needs the
     * file. Sent unconditionally: it is one line, it is only sent when the path
     * actually changed, and withholding it to protect whatever might be on the
     * input line trades a certain wrong file for a possible retyped sentence.
     */
    if (previous && previous !== path) {
      typeIntoSession(
        sessionId,
        `Your handover file has moved: write it to ${resolved} from now on, not ${resolveHandoverPath(previous)}. ` +
          (existsSync(resolved)
            ? `Keep it current as you work.`
            : `It does not exist yet — start it by carrying forward whatever still matters from the old one, especially anything written nowhere else, and keep it current as you work.`),
      );
    }
    note(
      existing,
      `handover file set to ${path} — asked for at ${Math.round(HANDOVER_AT * 100)}% context${wantsClear ? ", then cleared" : ", no clear"}`,
    );
    saveState(state);
    return {
      ok: true,
      managed: true,
      message:
        `${name} will be asked to hand over at ${Math.round(HANDOVER_AT * 100)}% of its context, into ${path}.\n` +
        (resolved === path
          ? ""
          : `  Today that resolves to ${resolved}; the date is worked out each time it is asked for, not now.\n`) +
        (wantsClear
          ? `  It is then cleared, once that file has changed on disk and not before.\n` +
            `  Note: a clear cannot run while a turn is in progress — for a session that works in\n` +
            `  long turns it will queue rather than take effect. Prefer the default there.`
          : `  It is NOT cleared — it keeps its context and carries on, and the terminal compacts\n` +
            `  when it needs to. The handover is what makes that compaction cheap.\n` +
            `  Add the word "clear" after the path if you want the old behaviour.`) +
        (existsSync(resolved)
          ? ""
          : `\n  NOTE: ${resolved} does not exist yet. It counts as changed when first written, and the\n  request will tell the session to carry forward what still matters from the most recent one beside it.`),
    };
  }

  if (word === "pause" || word === "resume") {
    if (!existing) return { ok: false, message: `${name} is not being managed` };
    existing.paused = word === "pause";
    saveState(state);
    return { ok: true, managed: true, message: `${word === "pause" ? "paused" : "resumed"} managing ${name}` };
  }

  if (!existing) {
    /**
     * REFUSE TO MANAGE ANYTHING THAT IS NOT A SESSION.
     *
     * `aibroker manage status <session>` — keyword first, session second —
     * resolved to the plain shell the command was typed in, and the remainder
     * became an objective: a manager was created for a `-zsh` pane, silently,
     * with the objective "status <session>". Nothing would ever have come of it
     * except goals typed at a shell prompt.
     *
     * The arm path already refuses a bare shell. That is too late: by then a
     * manager exists, appears in every listing, and has to be found and removed
     * by somebody who did not create it on purpose. Check at the point of
     * creation, where the mistake is still one command old.
     */
    const probe = readSessionContent(sessionId, 5);
    if (probe?.atPrompt) {
      return {
        ok: false,
        message:
          `${name} is a shell prompt, not a running session — refusing to manage it.\n` +
          `If you meant a different session, name it first: aibroker manage <session> <objective>`,
      };
    }

    const m: ManagedSession = {
      sessionId,
      name,
      objective: arg,
      pending: [],
      history: [],
      // Give the session the benefit of the grace period rather than arming
      // on top of whatever it is doing at the moment the operator types this.
      lastRearmAt: Date.now(),
      lastChangeAt: Date.now(),
      lastHash: hash(readPane(sessionId)),
      tty: snapshotTty(sessionId),
      paused: false,
      // Pinned here so every later write goes to the checkout this session was
      // started in, whatever the pane does afterwards.
      repoRoot: repoRootForSession(sessionId),
      startedAt: Date.now(),
    };
    state[sessionId] = m;
    note(m, "started");
    saveState(state);
    startManagerLoop();
    return {
      ok: true,
      managed: true,
      message: `managing ${name}. It will be re-armed with this objective whenever it stops:\n  ${arg}`,
    };
  }

  if (word === "now") {
    existing.lastRearmAt = 0;
    saveState(state);
    return { ok: true, managed: true, message: `${name} will be armed on the next tick` };
  }

  existing.pending.push(arg);
  note(existing, `operator: ${arg.slice(0, 80)}`);
  saveState(state);
  return {
    ok: true,
    managed: true,
    message: `noted for ${name} — it goes out with the next arming (${existing.pending.length} pending)`,
  };
}
