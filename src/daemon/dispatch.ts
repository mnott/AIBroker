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
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { saveJson, loadJson } from "../core/json-store.js";
import { audit } from "./audit.js";
import { snapshotAllSessions, wasLastEnumerationReliable } from "../transport/sync-facade.js";
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
  /**
   * INTERNAL — set only by redriveQueuedDispatches. Marks this dispatch as the
   * one redrive a queued record gets, so the fresh record a `queued` outcome
   * writes is generation-counted and never redriven again. Not part of the
   * public surface.
   */
  redriveCount?: number;
}

/**
 * Everything dispatch() touches outside itself, injected so the outcome matrix
 * can be tested without iTerm, a daemon, or a real `pai` binary. Production
 * callers omit it and get the real implementations.
 */
export interface DispatchDeps {
  resolve: (name: string) => Promise<PaiProject | undefined>;
  sessions: () => { id: string; name: string; paiName: string | null }[];
  /**
   * Did `sessions()` actually enumerate, or fall back to `[]` after a failed
   * osascript call? An empty array means two different things and only this
   * tells them apart — see the spawn-gate below.
   */
  sessionsReliable: () => boolean;
  deliver: (sessionId: string, body: string, timeoutMs: number, io?: TerminalIO, retries?: number) => Promise<AckResult>;
  launch: (project: PaiProject, opts?: { initialPrompt?: string }) => Promise<{ itermSessionId: string }>;
  waitReady: (sessionId: string, timeoutMs: number) => Promise<boolean>;
  /**
   * INTERNAL — Todoist fetch used only by the redrive freshness gate, so tests
   * can drive it without the network. Defaults to the global fetch.
   */
  todoistFetch?: typeof fetch;
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
 * first drawn box appended its work order to `/Name Voice Notes` and `go` —
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
  sessionsReliable: wasLastEnumerationReliable,
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

    // Write-ahead: a record on disk BEFORE the type, not after. `queued` means
    // the text left our hands for Claude Code's own in-terminal queue, which we
    // cannot see into — if that queue drops it (pane closed, session killed
    // mid-turn, daemon restarted and nobody re-checked) there was previously
    // NOTHING anywhere recording that this dispatch ever happened. Deleted
    // below the moment delivery is actually confirmed; kept otherwise so
    // redriveQueuedDispatches() has something to find.
    const queuedRecordPath = writeQueuedRecord(projectName, label, message, opts.prefix, opts.redriveCount);

    // One attempt, never three. The text is already in a live session's input
    // box; typing it again does not retry, it duplicates — one trigger became
    // three full job sweeps on 2026-08-01. Retries belong to the spawn path
    // below, where an earlier attempt may genuinely never have landed.
    const res = await deps.deliver(existing.id, body, deliverTimeoutMs(), undefined, 1);
    if (res === "ok") {
      deleteQueuedRecord(queuedRecordPath);
      return { outcome: "delivered", project: label, session: existing.label, reason: "" };
    }
    if (res === "unreadable") {
      // Never typed — nothing was queued anywhere, so there is nothing to redrive.
      deleteQueuedRecord(queuedRecordPath);
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
        `within the window. This is delivery, not failure — do NOT retry. Recorded at ${queuedRecordPath} ` +
        `in case it turns out to have been lost; redriven once on the next daemon start.`,
    };
  }

  // Enumeration itself may have failed rather than truthfully found nothing —
  // an osascript hiccup returns `[]` indistinguishable from an empty machine.
  // Reading that as "target absent" spawns a session next to one that already
  // exists, or — worse — the write for that spawn can land on whatever pane
  // happened to be current, which is exactly how a launch command ends up
  // typed into a live Claude pane instead of a fresh shell. Unknown is not
  // absent: report it as a transient failure so the caller retries instead of
  // either giving up (`unlaunchable`) or launching blind.
  if (!deps.sessionsReliable()) {
    return {
      outcome: "unreachable",
      project: label,
      session: "",
      reason:
        `Session enumeration failed, so whether "${label}" already has a live session could not be ` +
        `confirmed. Not launching one on an unverified "no session" — retry once enumeration recovers.`,
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

// ── queued-dispatch persistence ─────────────────────────────────────────────
//
// "queued" means the body was typed into a live session's input box and Claude
// Code's own turn-queue is now the only place holding it — we cannot see into
// that queue, so we cannot confirm it ran. On 2026-09-23 one of these was
// typed, never ran, and there was no record anywhere that it had ever been
// attempted: not a work-order file (those are written only on the spawn path),
// not anything else. This is the record that was missing.

interface QueuedDispatchRecord {
  /** The name dispatch() was originally called with — re-resolved on redrive. */
  project: string;
  label: string;
  /** Raw message, NOT prefixed — redrive calls dispatch() again, which prefixes it itself. */
  message: string;
  prefix?: string;
  createdAt: number;
  /**
   * Set when this record was written BY a redrive, not by a fresh dispatch.
   * A record that has already had its one redrive is dropped on the next
   * start rather than sent again — see redriveQueuedDispatches.
   */
  redriveCount?: number;
}

const QUEUED_DIR = join(homedir(), ".aibroker", "queued-dispatches");

/** Persist a queued dispatch before it is typed. Returns the record's path. */
function writeQueuedRecord(
  project: string,
  label: string,
  message: string,
  prefix?: string,
  redriveCount?: number,
): string {
  const path = join(QUEUED_DIR, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  const record: QueuedDispatchRecord = { project, label, message, prefix, createdAt: Date.now() };
  if (redriveCount !== undefined) record.redriveCount = redriveCount;
  try {
    saveJson(path, record, { backup: false });
  } catch (err) {
    log(`dispatch: could not persist queued-dispatch record for "${label}": ${err instanceof Error ? err.message : String(err)}`);
  }
  return path;
}

function deleteQueuedRecord(path: string): void {
  try { unlinkSync(path); } catch { /* already gone, or never written */ }
}

/**
 * How long a queued (typed-but-unacked) dispatch is left alone before it is
 * treated as possibly lost. Long enough that a genuinely busy Claude turn has
 * finished and consumed it — the sweeps this exists for run for minutes, not
 * hours — short enough to catch a same-morning daemon restart like 2026-09-23's
 * (07:37 dispatch, 07:42/07:44 restarts, never redriven because nothing
 * persisted the attempt).
 */
const QUEUED_REDRIVE_GRACE_MS = 5 * 60 * 1000;

// ── was a queued dispatch in fact consumed? ────────────────────────────────
//
// Real fault, 2026-09-24: a dispatch typed into a busy session at 06:56 was
// read and handled by that session minutes later — it is in its transcript —
// but the queued record stayed on disk, because nothing marks a record
// consumed. Every daemon restart then re-typed the same message into the same
// session (the 11:02 restart delivered it a second time), and THAT delivery
// wrote its own record, so each restart meant one more duplicate, forever.
// The transcript is the ground truth of what a session actually received, so
// it is what decides whether a redrive is a recovery or a duplicate.

/**
 * Substrings that identify `message` inside a transcript entry.
 *
 * Both ends, not just the head: a long body delivered into a busy input box
 * can lose its head (measured 2026-09-24: ~700 of ~5000 chars survived, and
 * they were the tail), so a head-only needle would miss exactly the deliveries
 * that most need finding. Drawn from single lines and capped, so a needle
 * never spans a newline.
 */
function transcriptNeedles(message: string): string[] {
  const lines = message.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (!lines.length) return [];
  return [...new Set([lines[0].slice(0, 80), lines[lines.length - 1].slice(-80)])];
}

/**
 * Does the target project's transcript already hold this message?
 *
 *   true      — a user message created after the record contains a distinctive
 *               slice of it: the session received it, redelivering duplicates.
 *   false     — transcript resolvable, message absent: a redrive is warranted.
 *   undefined — no transcript could be resolved (no curated project, no
 *               rootPath, no ~/.claude/projects dir for it): cannot tell.
 */
async function queuedDispatchConsumed(
  record: QueuedDispatchRecord,
  deps: DispatchDeps,
): Promise<boolean | undefined> {
  if (typeof record.createdAt !== "number") return undefined;
  const needles = transcriptNeedles(record.message);
  if (!needles.length) return undefined;
  const project = await deps.resolve(record.project).catch(() => undefined);
  const rootPath = project?.rootPath;
  if (!rootPath) return undefined;
  // Same encoding Claude Code uses for ~/.claude/projects/<dir>: every
  // non-alphanumeric in the cwd becomes a dash — measured against real dirs
  // ("/Users/x/.claude" -> "-Users-x--claude"). The five newest transcripts
  // cover every session that could have consumed it recently.
  const dir = join(homedir(), ".claude", "projects", rootPath.replace(/[^a-zA-Z0-9]/g, "-"));
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)
      .slice(0, 5)
      .map((e) => e.f);
  } catch {
    return undefined;
  }
  if (!files.length) return undefined;

  // grep for the JSON-ESCAPED spelling: a needle containing a quote never
  // appears verbatim in a JSONL line, only as its escaped form. Whole-file
  // scans, because the consumed entry can sit far above a busy session's tail.
  const patterns = needles.flatMap((n) => ["-e", JSON.stringify(n).slice(1, -1)]);
  for (const f of files) {
    let hits: string;
    try {
      hits = execFileSync("/usr/bin/grep", ["-F", ...patterns, join(dir, f)], {
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 32 * 1024 * 1024,
      });
    } catch {
      continue; // no match in this file (grep exits 1) — next transcript
    }
    for (const line of hits.split("\n")) {
      if (!line.trim()) continue;
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // truncated by a concurrent write — skip it
      }
      // Typed-in text only. Tool results are user-type entries too and can
      // echo the body (a session reading the record file itself), which is
      // a mention, not a delivery.
      if (entry?.type !== "user") continue;
      const content = entry.message?.content;
      const text = typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n")
          : "";
      if (!text) continue;
      const at = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
      if (Number.isNaN(at) || at < record.createdAt) continue;
      if (needles.some((n) => text.includes(n))) return true;
    }
  }
  return false;
}

// ── a queued todoist dispatch must still be current ─────────────────────────
//
// Real fault, 2026-09-24 (records 1790226222101/1790226253580): a dispatch sat
// queued for 4h and was then re-driven, long after the run it asked for had
// happened and been completed. A todoist dispatch's `[todoist:<id>` trailer
// names the task it came from, and that task says whether the order is still
// wanted: unfetchable means the trigger is closed, and a due date moved far
// past the queueing moment means the occurrence was completed since.

/** How far the due date may legitimately sit past queueing: a trigger fires ON its due time, so anything further is a new occurrence. */
const REDRIVE_DUE_TOLERANCE_MS = 60 * 60 * 1000;

const TODOIST_TRAILER = /\[todoist:(\d+)(?:\s+in:[^\]]*)?\]/;

/**
 * Why this record's todoist task makes a redrive stale, or undefined when the
 * dispatch is still current — or cannot be judged, which must NOT drop it.
 */
async function staleTodoistTrailer(
  record: QueuedDispatchRecord,
  fetchImpl: typeof fetch,
): Promise<string | undefined> {
  const taskId = TODOIST_TRAILER.exec(record.message)?.[1];
  if (!taskId) return undefined;
  try {
    const { fetchParentTask } = await import("./todoist-reply.js");
    const parent = await fetchParentTask(taskId, fetchImpl);
    const due = parent.due?.date ? Date.parse(parent.due.date) : NaN;
    if (Number.isFinite(due) && due > record.createdAt + REDRIVE_DUE_TOLERANCE_MS) {
      return `task ${taskId} is due ${parent.due?.date}, well past the ${new Date(record.createdAt).toISOString()} it was queued at — the occurrence advanced, the run already happened`;
    }
    return undefined;
  } catch (err) {
    // A fetch that never got an answer says nothing about the task: keep the
    // record. Only a definitive "gone" (404/401/…, per the webhook's own
    // transient/permanent classifier) is evidence the trigger is closed.
    const { isTransientTodoistError } = await import("./todoist-webhook.js");
    if (isTransientTodoistError(err)) return undefined;
    return `task ${taskId} is no longer fetchable (${err instanceof Error ? err.message : String(err)}) — closed since the dispatch was queued`;
  }
}

/**
 * Re-attempt every queued dispatch still on disk from before this start.
 * Call once, at daemon startup.
 *
 * Not provably exactly-once: if the original typed input was in fact consumed
 * moments after its own delivery window closed, this can deliver a second
 * copy — the same risk `dispatch()`'s single-attempt rule accepts for a normal
 * retry. The alternative is what actually happened: a dispatch typed into a
 * live session, never run, nothing anywhere to say so, and no way to recover
 * it. A record aged past the grace period is stronger evidence of loss than of
 * a slow turn.
 *
 * Bounded, not a retry loop: a record whose todoist task has since closed or
 * completed is dropped as stale, a record whose transcript shows the session
 * already received it is deleted as consumed, a record that has already had
 * its one redrive is dropped without sending, and whatever this pass leaves
 * behind (still `queued`, `unreachable`, `unlaunchable`) is dropped after one
 * audited attempt rather than kept for the next restart, so a daemon that
 * restarts repeatedly cannot turn this into a duplicate-dispatch storm.
 */
export async function redriveQueuedDispatches(deps: DispatchDeps = realDeps): Promise<void> {
  let names: string[];
  try {
    names = readdirSync(QUEUED_DIR).filter((n) => n.endsWith(".json"));
  } catch {
    return; // directory does not exist yet — nothing was ever queued
  }
  const cutoff = Date.now() - QUEUED_REDRIVE_GRACE_MS;
  for (const name of names) {
    const path = join(QUEUED_DIR, name);
    let record: QueuedDispatchRecord;
    try {
      if (statSync(path).mtimeMs >= cutoff) continue; // still inside its own delivery window
      const loaded = loadJson<QueuedDispatchRecord>(path);
      if (loaded.status !== "ok") {
        deleteQueuedRecord(path);
        continue;
      }
      record = loaded.data;
    } catch {
      continue;
    }

    // Second generation, one chance only. This record was written BY a redrive
    // whose transcript could not be checked; sending it again would make every
    // restart one more duplicate of the same work order.
    if ((record.redriveCount ?? 0) >= 1) {
      log(
        `dispatch: dropping queued dispatch for "${record.label}" — already redriven once ` +
        `(from ${new Date(record.createdAt).toISOString()}) and never confirmed, not sending it again`,
      );
      audit({
        action: "dispatch-redrive",
        actor: "aibroker:daemon-start",
        target: record.project,
        outcome: "dropped",
        body: record.message,
        reason: "already redriven once and never confirmed — dropped rather than risk another duplicate",
        meta: { project: record.project, originallyQueuedAt: record.createdAt, redriveCount: record.redriveCount },
      });
      deleteQueuedRecord(path);
      continue;
    }

    // Still current? A todoist-trailer dispatch names its task; if that task
    // has since been completed (due advanced) or closed, re-driving would
    // resurrect a run that already happened. Checked before the transcript
    // scan: one task lookup is cheaper than grepping five transcripts, and it
    // answers first when both would apply.
    const stale = await staleTodoistTrailer(record, deps.todoistFetch ?? fetch);
    if (stale) {
      log(`dispatch: dropping queued dispatch for "${record.label}" — ${stale}`);
      audit({
        action: "dispatch-redrive",
        actor: "aibroker:daemon-start",
        target: record.project,
        outcome: "dropped",
        body: record.message,
        reason: stale,
        meta: { project: record.project, originallyQueuedAt: record.createdAt },
      });
      deleteQueuedRecord(path);
      continue;
    }

    // Consumed already? The transcript says whether the session ever read it.
    const consumed = await queuedDispatchConsumed(record, deps);
    if (consumed) {
      log(`dispatch: queued dispatch for "${record.label}" already consumed, not redriving`);
      audit({
        action: "dispatch-redrive",
        actor: "aibroker:daemon-start",
        target: record.project,
        outcome: "consumed",
        body: record.message,
        reason: "found in the target project's transcript after the record was written — the first delivery landed",
        meta: { project: record.project, originallyQueuedAt: record.createdAt },
      });
      deleteQueuedRecord(path);
      continue;
    }

    log(
      `dispatch: redriving queued dispatch for "${record.label}" left over from ` +
      `${new Date(record.createdAt).toISOString()} (${path})`,
    );
    const result = await dispatch(
      record.project,
      record.message,
      { prefix: record.prefix, redriveCount: 1 },
      deps,
    );
    audit({
      action: "dispatch-redrive",
      actor: "aibroker:daemon-start",
      target: result.session || record.project,
      outcome: result.outcome,
      body: record.message,
      reason: result.reason || undefined,
      meta: { project: result.project, originallyQueuedAt: record.createdAt },
    });
    // Delete unconditionally: `delivered`/`spawned` need no further record, and
    // a fresh `queued` result already wrote ITS OWN record above — marked
    // redriveCount so the next start drops it instead of redelivering.
    deleteQueuedRecord(path);
  }
}
