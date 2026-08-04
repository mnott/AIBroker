/**
 * daemon/dispatch.ts — deliver a work order to a project's session.
 *
 * The transport half of PAI's task bus: PAI decides which project owns a task,
 * hands us the project name plus a message body, and we resolve that to a live
 * session and deliver it — spawning the session if none is running.
 *
 * ONE atomic call on purpose. A caller doing list → launch → send itself races:
 * a session can start or die between the check and the send, and the caller ends
 * up duplicating session-lifecycle logic it doesn't own.
 *
 * Outcomes are RESULTS, not errors. A task the bus can't route is an ordinary
 * thing to report and move past — a batch must not abort because one project
 * lacks an alias. Only genuine infrastructure failure throws.
 *
 *   delivered    — a live session accepted it
 *   queued       — typed into a live session that was mid-turn. Claude Code
 *                  queues input during a turn, so silence is not evidence of
 *                  non-delivery. This is SUCCESS: never retry it. Retrying
 *                  duplicates, and one trigger became three job sweeps.
 *   spawned      — no session ran; we launched one and it accepted it
 *   unlaunchable — no curated alias. Setup gap: `pai project name <id> <short>`
 *   unreachable  — tab opened but the session never accepted input. Runtime bug.
 *   skipped      — no live session and spawning was disabled
 *
 * `unlaunchable` and `unreachable` are deliberately distinct: the first is a
 * missing alias, the second is a session that failed to come up. Collapsing
 * them sends whoever reads the result looking in the wrong place.
 */

import { mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { snapshotAllSessions } from "../transport/sync-facade.js";
import {
  findCuratedPaiProject,
  launchResolvedPaiProject,
  invalidatePaiProjectCache,
  type PaiProject,
} from "./pai-projects.js";
import { getAllPersistentSessionNames, lookupPersistentName } from "../core/persistence.js";
import { type AckResult } from "./sessions.js";
import {
  INPUT_LINE,
  CLAUDE_UI,
  flatten,
  inputBoxLines,
  isClaudeReady,
  isInputBoxEmpty,
  hasBeenSubmitted,
  realIO,
  sleep,
  type TerminalIO,
} from "./terminal-screen.js";
import { log } from "../core/log.js";
import { matchSession } from "../core/session-match.js";

export type DispatchOutcome =
  | "delivered"
  | "queued"
  | "spawned"
  | "unlaunchable"
  | "unreachable"
  | "skipped";

export interface DispatchResult {
  outcome: DispatchOutcome;
  project: string;
  session: string;
  reason: string;
}

export interface DispatchOptions {
  /** Never launch a session; report `skipped` instead. */
  noSpawn?: boolean;
  /**
   * Total wall-clock budget for the WHOLE dispatch, caller-supplied.
   *
   * Stages must share one deadline, not hold their own. Spawning runs
   * readiness and then delivery in sequence, so per-stage limits add up: a 180s
   * readiness limit plus a 120s delivery limit is a 300s worst case, which
   * silently outlives a caller that budgeted 180s and kills the process itself.
   * The caller then sees its own timeout instead of our reason — a failure we
   * cannot reproduce from this side. One budget, split across the stages.
   */
  budgetMs?: number;
  /** Cap on the readiness wait, within the budget. */
  spawnTimeoutMs?: number;
  /** Cap on the delivery wait, within the budget. */
  deliverTimeoutMs?: number;
  /**
   * Routing prefix, when the default does not fit.
   *
   * A comment on a task in flight is a correction, not a new work order, and
   * `[Task]` tells the receiving session to start. `[Task:comment]` tells it to
   * adjust what it already has.
   */
  prefix?: string;
}

/**
 * Everything dispatch() touches outside itself, injected so the outcome matrix
 * can be tested without iTerm, a daemon, or a real `pai` binary. Production
 * callers omit it and get the real implementations.
 */
export interface DispatchDeps {
  resolve: (name: string) => Promise<PaiProject | undefined>;
  sessions: () => { id: string; name: string; paiName: string | null }[];
  deliver: (sessionId: string, body: string, timeoutMs: number, io?: TerminalIO, retries?: number) => Promise<AckResult>;
  launch: (project: PaiProject, opts?: { initialPrompt?: string }) => Promise<{ itermSessionId: string }>;
  waitReady: (sessionId: string, timeoutMs: number) => Promise<boolean>;
  /** Read a session's screen, to confirm Claude still owns the tty. */
  capture: (sessionId: string) => string | null;
  /** Clock for the shared budget; injectable so budget maths is testable. */
  now: () => number;
}

/** A spawned Claude needs to boot and run its `/Name … go` preamble first. */
const DEFAULT_SPAWN_TIMEOUT_MS = 90_000;
const DEFAULT_DELIVER_TIMEOUT_MS = 120_000;
const READY_POLL_MS = 1_000;

/**
 * Routing prefix for dispatched work.
 *
 * Deliberately NOT `[Session:PAI]`. That prefix means "reply to the sender on
 * this channel", and for a dispatched task there is no sender left to reply to —
 * the CLI that sent it has already exited. Promising a reply path that doesn't
 * exist is worse than promising none, so `[Task]` says: act on it, don't reply,
 * report by closing it on the tracker.
 *
 * The body carries the same contract in words, because a session that has never
 * seen `[Task]` before must still do the right thing.
 */
export const TASK_PREFIX = "[Task]";

// Screen-reading lives in terminal-screen.ts, shared with `ask`. Re-exported
// here because these were dispatch's before `ask` needed them too.
export {
  isClaudeReady,
  hasBeenSubmitted,
  flatten,
  realIO,
  type TerminalIO,
} from "./terminal-screen.js";

/**
 * Find a running session for `project`.
 *
 * Matches the project's display name, canonical name and every curated alias,
 * case-insensitively — session labels and aliases disagree on capitalisation
 * often enough that an exact match silently spawns a duplicate tab.
 */
export function findSessionForProject(
  project: PaiProject,
  sessions: { id: string; name: string; paiName: string | null }[],
): { id: string; label: string } | null {
  // Exact and separator-folded only — never substring. A project called `sl`
  // would otherwise match any session whose title contains those letters, and
  // here a wrong match does not spawn, it delivers work to the wrong session.
  const hit = matchSession(
    [project.displayName, project.name, project.slug, ...project.names],
    sessions,
    { kinds: ["exact", "normalised"] },
  );
  return hit ? { id: hit.session.id, label: hit.label } : null;
}

/** Enumerate live sessions with their persistent (PAI) names resolved. */
function liveSessions(): { id: string; name: string; paiName: string | null }[] {
  const snaps = snapshotAllSessions();
  const persistent = getAllPersistentSessionNames();
  return snaps.map((s) => ({
    id: s.id,
    name: s.name,
    paiName: lookupPersistentName(persistent, s.id, s.aibrokerId),
  }));
}

/** A live session with its persistent PAI name resolved. */
export interface LiveSession { id: string; name: string; paiName: string | null }

/**
 * Wait until a freshly launched session can ACCEPT input.
 *
 * Note "accept", not "be idle". A launched session immediately runs its
 * `/Name … go` preamble and stays busy for minutes; waiting for the screen to
 * settle times out on a session that is perfectly healthy — which is exactly
 * what the first version did. Claude Code queues typed input while it works, so
 * idleness is the wrong gate.
 *
 * But "the box is drawn" was too weak. The preamble is typed into that box and
 * sits there unsubmitted while it is drawn, so a dispatcher that fired on the
 * first drawn box appended its work order to `/Name Jobs Grazyna` and `go` —
 * three inputs racing in one box, with the user's own typing landing in the
 * middle of it. Reported live on 2026-08-04.
 *
 * The gate is therefore drawn AND empty: the preamble has been submitted and
 * the box is free. A busy session still qualifies, which preserves the point of
 * the paragraph above.
 */
export async function waitForReady(
  sessionId: string,
  timeoutMs: number,
  io: TerminalIO = realIO,
): Promise<boolean> {
  const deadline = io.now() + timeoutMs;
  while (io.now() < deadline) {
    await io.sleep(READY_POLL_MS);
    const frame = io.capture(sessionId);
    if (frame === null) continue;
    if (isClaudeReady(frame) && isInputBoxEmpty(frame)) return true;
  }
  return false;
}

/**
 * Type `body` into a session and confirm Claude actually took it.
 *
 * Frame-counting (what `sessions checkpoint` uses) can't be trusted here: a
 * session mid-task animates constantly, so "the screen changed" is true whether
 * or not our text was submitted. Instead we use the one transition that only
 * happens on submit — the text leaves the input box and appears above it:
 *
 *   present in the frame, AND no longer on the ❯ input line  ->  submitted
 *
 * That works identically whether the session is idle or busy, which is the
 * whole point for a freshly spawned session that is still running `go`.
 */
export async function submitAndConfirm(
  sessionId: string,
  body: string,
  timeoutMs: number,
  io: TerminalIO = realIO,
  retries = 3,
): Promise<AckResult> {
  if (io.capture(sessionId) === null) return "unreadable";

  // A short distinctive slice: long bodies wrap and get truncated on screen.
  const needle = flatten(body.split("\n").find((l) => l.trim().length > 0) ?? body).slice(0, 48);
  if (!needle) return "no-ack";

  // `timeoutMs` is a hard ceiling on this call, retries included. An earlier
  // version floored the per-attempt wait at 4s, which quietly overrode a
  // smaller budget: three attempts still ran for 12s when the caller allowed
  // less. Anything that can outlive the caller's own kill timer defeats the
  // point of being handed a budget at all.
  const overallDeadline = io.now() + timeoutMs;
  const perAttempt = Math.max(Math.min(4000, timeoutMs), Math.floor(timeoutMs / retries));

  for (let attempt = 1; attempt <= retries; attempt++) {
    if (io.now() >= overallDeadline) break;
    io.send(sessionId, body);
    const deadline = Math.min(overallDeadline, io.now() + perAttempt);
    while (io.now() < deadline) {
      await io.sleep(500);
      const frame = io.capture(sessionId);
      if (frame === null) continue;
      if (hasBeenSubmitted(frame, needle)) return "ok";
    }
  }
  return "no-ack";
}

/** Production wiring for DispatchDeps. */
const realDeps: DispatchDeps = {
  resolve: findCuratedPaiProject,
  sessions: liveSessions,
  deliver: submitAndConfirm,
  capture: (id) => realIO.capture(id),
  now: () => Date.now(),
  launch: launchResolvedPaiProject,
  waitReady: waitForReady,
};

function ackReason(res: AckResult): string {
  switch (res) {
    case "no-ack": return "session did not accept the message (never reacted)";
    case "no-settle": return "session accepted the message but was still working when the timeout expired";
    case "unreadable": return "session terminal could not be read";
    default: return "";
  }
}

/**
 * Resolve `project` to a session and deliver `message`, spawning if needed.
 *
 * Never throws for a routing outcome — see the module comment.
 */
export async function dispatch(
  projectName: string,
  message: string,
  opts: DispatchOptions = {},
  deps: DispatchDeps = realDeps,
): Promise<DispatchResult> {
  const startedAt = deps.now();
  const budgetMs = opts.budgetMs;
  /** Time left in the caller's budget; Infinity when they set none. */
  const left = (): number =>
    budgetMs === undefined ? Infinity : Math.max(0, budgetMs - (deps.now() - startedAt));

  const spawnTimeoutMs = Math.min(opts.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS, left());
  const deliverTimeoutMs = () => Math.min(opts.deliverTimeoutMs ?? DEFAULT_DELIVER_TIMEOUT_MS, left());

  const project = await deps.resolve(projectName);
  if (!project) {
    return {
      outcome: "unlaunchable",
      project: projectName,
      session: "",
      reason:
        `No curated alias for "${projectName}". Bus participation is opt-in: ` +
        `run \`pai project name <identifier> ${projectName}\` to register one.`,
    };
  }

  const label = project.displayName || project.name;
  const body = `${opts.prefix ?? TASK_PREFIX} ${message}`;

  // ── already running? ──
  const existing = findSessionForProject(project, deps.sessions());
  if (existing) {
    if (left() <= 0) {
      return {
        outcome: "unreachable",
        project: label,
        session: existing.label,
        reason: `Budget of ${Math.round((budgetMs ?? 0) / 1000)}s left no time to deliver in.`,
      };
    }
    // Confirm Claude is actually the thing at the prompt before typing a work
    // order into it. A session whose Claude has exited keeps its PAI name and
    // still matches here, but the tty now belongs to a shell — and a shell
    // EXECUTES what it is sent. Task bodies are multi-line and full of
    // backticks, so this is the difference between a failed delivery and
    // running fragments of a task description as commands.
    const frame = deps.capture(existing.id);
    if (frame !== null && !isClaudeReady(frame)) {
      return {
        outcome: "unreachable",
        project: label,
        session: existing.label,
        reason:
          `Session "${existing.label}" is no longer running Claude — its terminal is at a shell ` +
          `prompt. Nothing was sent, because a shell would execute the message rather than read it.`,
      };
    }

    // One attempt, never three. The text is already in a live session's input
    // box; typing it again does not retry, it duplicates — one trigger became
    // three full job sweeps on 2026-08-01. Retries belong to the spawn path
    // below, where an earlier attempt may genuinely never have landed.
    const res = await deps.deliver(existing.id, body, deliverTimeoutMs(), undefined, 1);
    if (res === "ok") {
      return { outcome: "delivered", project: label, session: existing.label, reason: "" };
    }
    if (res === "unreadable") {
      return {
        outcome: "unreachable",
        project: label,
        session: existing.label,
        reason: `Live session found but ${ackReason(res)}.`,
      };
    }
    // Typed into a live session that did not react in time. Claude Code queues
    // input while a turn is running and does not read it until the turn ends,
    // so silence is not evidence of non-delivery — it is the ordinary state of
    // a session that is busy working. Calling that `unreachable` made a caller
    // count a strike, report the routine as not running, and dispatch again.
    return {
      outcome: "queued",
      project: label,
      session: existing.label,
      reason:
        `Typed into live session "${existing.label}", which was still working and had not read it ` +
        `within the window. This is delivery, not failure — do NOT retry.`,
    };
  }

  if (opts.noSpawn) {
    return {
      outcome: "skipped",
      project: label,
      session: "",
      reason: "No live session and spawning was disabled (--no-spawn).",
    };
  }

  // ── spawn, wait for it to come up, then deliver ──

  // Check the budget BEFORE launching, not after waiting for readiness.
  // Launching with no time to deliver cannot succeed, and it is not a harmless
  // failure: it leaves a real Claude session running that nobody asked for, and
  // then blames it for "not becoming ready" — sending whoever reads the result
  // to inspect a tab that was never given a chance.
  if (left() <= 0) {
    return {
      outcome: "unreachable",
      project: label,
      session: "",
      reason:
        `Budget of ${Math.round((budgetMs ?? 0) / 1000)}s was already spent before a session ` +
        `could be launched, so none was — nothing to investigate at the project end. ` +
        `Raise the timeout.`,
    };
  }

  // Hand the work order over IN the launch, not by typing afterwards.
  //
  // See the long note in pai-projects.ts: a freshly launched session holds its
  // `/Name … go` preamble as queued prompts that are not rendered anywhere, so
  // "the session looks ready" is true for ~8 seconds before those prompts run.
  // Typing into that window interleaves the work order with the rename and the
  // resume. The queue is ordered and nothing else writes to it, so passing the
  // order as the second queued prompt is race-free by construction.
  //
  // Via a file because the queue separator is a newline: a multi-line body
  // passed inline would arrive as several unrelated prompts. One line pointing
  // at the body keeps the body arbitrarily long and the instruction atomic.
  let orderPath: string;
  try {
    orderPath = writeWorkOrder(label, body);
  } catch (err) {
    return {
      outcome: "unreachable",
      project: label,
      session: "",
      reason: `Could not stage the work order: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let itermSessionId: string;
  try {
    ({ itermSessionId } = await deps.launch(project, {
      initialPrompt:
        `${opts.prefix ?? TASK_PREFIX} Your work order is in ${orderPath} — read that file and carry it out. ` +
        `It was written for this session only; delete it once you have read it.`,
    }));
  } catch (err) {
    return {
      outcome: "unreachable",
      project: label,
      session: "",
      reason: `Failed to launch a session: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  invalidatePaiProjectCache();
  log(`dispatch: launched "${label}" as ${itermSessionId}, waiting for it to accept input`);

  if (!(await deps.waitReady(itermSessionId, spawnTimeoutMs))) {
    return {
      outcome: "unreachable",
      project: label,
      session: label,
      reason:
        `Launched a session in ${project.rootPath} but it did not become ready within ` +
        `${Math.round(spawnTimeoutMs / 1000)}s` +
        (budgetMs !== undefined && spawnTimeoutMs < DEFAULT_SPAWN_TIMEOUT_MS
          // Say which limit actually bit. A budget-clipped wait points at the
          // caller's timeout, not at a session that may be perfectly healthy.
          ? ` — that was the caller's ${Math.round(budgetMs / 1000)}s budget, not the ` +
            `${Math.round(DEFAULT_SPAWN_TIMEOUT_MS / 1000)}s default, so raise the timeout before suspecting the session.`
          : `. The tab is open — check why it did not start.`),
    };
  }

  // No budget check here any more, and its absence is the point.
  //
  // While the work order was TYPED after boot, a boot that ate the budget left
  // nothing to deliver in, and `unreachable` was the honest answer. Now the
  // order is queued by the launch itself, so once the tab exists the work is
  // handed over whether or not the clock ran out. Reporting failure at this
  // point would tell PAI to retry something that is already going to run — the
  // duplicate-dispatch failure, reintroduced from the other side.
  //
  // A slow boot is now a slow boot, not a lost task.

  // No delivery step: the order was queued by the launch and Claude Code runs
  // its queue in order. Readiness above is now a LIVENESS check — did a Claude
  // actually come up in that tab — rather than permission to start typing.
  log(`dispatch: "${label}" came up; work order was queued at launch (${orderPath})`);
  return { outcome: "spawned", project: label, session: label, reason: "" };
}

/**
 * Stage a work order on disk for a session that is about to be launched.
 *
 * Under ~/.aibroker so it survives nothing in particular — it is meant to be
 * short-lived, and the receiving session is told to delete it. Named after the
 * project and the clock so two dispatches for one project cannot overwrite each
 * other mid-launch.
 */
function writeWorkOrder(label: string, body: string): string {
  const dir = join(homedir(), ".aibroker", "work-orders");
  mkdirSync(dir, { recursive: true });
  pruneWorkOrders(dir);
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "task";
  const path = join(dir, `${slug}-${Date.now()}.md`);
  writeFileSync(path, body.endsWith("\n") ? body : `${body}\n`, "utf8");
  return path;
}

/** How long a staged work order is kept before it is assumed abandoned. */
const WORK_ORDER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Drop work orders old enough that nobody is coming back for them.
 *
 * The receiving session is told to delete its own order, and a healthy dispatch
 * does. Nothing deletes the others: a dispatch that fails after staging, a
 * session killed mid-run, a tab closed before it read the file. Each leaves a
 * copy of a work order — which is a copy of task content — sitting in the home
 * directory indefinitely.
 *
 * Swept on write rather than on a timer: the only moment this directory is
 * certainly in use is when something is being added to it, and a sweep that
 * needs its own schedule is one more thing that can stop running silently.
 *
 * A week, because the point is to bound the pile, not to race the reader. An
 * order still unread after seven days is not about to be read.
 */
function pruneWorkOrders(dir: string): void {
  try {
    const cutoff = Date.now() - WORK_ORDER_TTL_MS;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".md")) continue;
      const p = join(dir, name);
      try {
        if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
      } catch {
        /* vanished under us, or not ours to remove — either way, skip it */
      }
    }
  } catch {
    // Housekeeping must never cost a dispatch. A directory that cannot be read
    // is a reason to skip the sweep, not to fail the work order.
  }
}
