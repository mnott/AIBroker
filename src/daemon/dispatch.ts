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
 *   spawned      — no session ran; we launched one and it accepted it
 *   unlaunchable — no curated alias. Setup gap: `pai project name <id> <short>`
 *   unreachable  — tab opened but the session never accepted input. Runtime bug.
 *   skipped      — no live session and spawning was disabled
 *
 * `unlaunchable` and `unreachable` are deliberately distinct: the first is a
 * missing alias, the second is a session that failed to come up. Collapsing
 * them sends whoever reads the result looking in the wrong place.
 */

import { snapshotAllSessions } from "../transport/sync-facade.js";
import {
  findCuratedPaiProject,
  launchResolvedPaiProject,
  invalidatePaiProjectCache,
  type PaiProject,
} from "./pai-projects.js";
import { getAllPersistentSessionNames, lookupPersistentName } from "../core/persistence.js";
import { type AckResult } from "./sessions.js";
import { captureSession, typeIntoSession } from "../transport/sync-facade.js";
import { log } from "../core/log.js";

export type DispatchOutcome =
  | "delivered"
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
}

/**
 * Everything dispatch() touches outside itself, injected so the outcome matrix
 * can be tested without iTerm, a daemon, or a real `pai` binary. Production
 * callers omit it and get the real implementations.
 */
export interface DispatchDeps {
  resolve: (name: string) => Promise<PaiProject | undefined>;
  sessions: () => { id: string; name: string; paiName: string | null }[];
  deliver: (sessionId: string, body: string, timeoutMs: number) => Promise<AckResult>;
  launch: (project: PaiProject) => Promise<{ itermSessionId: string }>;
  waitReady: (sessionId: string, timeoutMs: number) => Promise<boolean>;
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Terminal access, injectable so the screen heuristics can be tested on real frames. */
export interface TerminalIO {
  capture: (id: string) => string | null;
  send: (id: string, text: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const realIO: TerminalIO = {
  capture: (id) => captureSession(id, 60),
  send: (id, text) => { typeIntoSession(id, text); },
  sleep,
  now: () => Date.now(),
};

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
  const wanted = new Set(
    [project.displayName, project.name, project.slug, ...project.names]
      .filter(Boolean)
      .map((s) => s.toLowerCase()),
  );
  for (const s of sessions) {
    const label = s.paiName ?? s.name;
    if (label && wanted.has(label.toLowerCase())) return { id: s.id, label };
  }
  return null;
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

/** The line Claude's input box is drawn on. */
const INPUT_LINE = /^\s*❯/;
/** Claude's input box: a prompt caret sitting inside a run of box-drawing rule. */
const CLAUDE_UI = /─{20,}/;

/** Collapse whitespace so wrapped/padded terminal text compares sanely. */
function flatten(s: string): string { return s.replace(/\s+/g, " ").trim(); }

/**
 * Wait until a freshly launched session can ACCEPT input.
 *
 * Note "accept", not "be idle". A launched session immediately runs its
 * `/Name … go` preamble and stays busy for minutes; waiting for the screen to
 * settle times out on a session that is perfectly healthy — which is exactly
 * what the first version did. Claude Code queues typed input while it works, so
 * the real gate is whether the input box has been drawn yet.
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
    if (isClaudeReady(frame)) return true;
  }
  return false;
}

/** True when a frame shows Claude's input box drawn and ready to take text. */
export function isClaudeReady(frame: string): boolean {
  return CLAUDE_UI.test(frame) && frame.split("\n").some((l) => INPUT_LINE.test(l));
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

/**
 * Has `needle` left the input box and landed in the transcript?
 *
 * Present on screen is not enough — text sitting unsubmitted in the input box is
 * also "present". Submission is the moment it appears while the ❯ line no longer
 * holds it.
 */
export function hasBeenSubmitted(frame: string, needle: string): boolean {
  const stillTyped = inputBoxLines(frame).some((l) => flatten(l).includes(needle.slice(0, 24)));
  return !stillTyped && flatten(frame).includes(needle);
}

/**
 * The lines inside Claude's input box.
 *
 * A caret alone will not do: Claude echoes each submitted message into the
 * transcript with the SAME `❯` marker, so "a ❯ line contains our text" is true
 * both before and after submitting — the check it was meant to power would
 * never fire. The input box is identified structurally instead, as the region
 * between the last two horizontal rules at the bottom of the frame.
 */
function inputBoxLines(frame: string): string[] {
  const lines = frame.split("\n");
  const rules: number[] = [];
  lines.forEach((l, i) => { if (CLAUDE_UI.test(l)) rules.push(i); });
  if (rules.length >= 2) {
    const [open, close] = [rules[rules.length - 2], rules[rules.length - 1]];
    return lines.slice(open + 1, close);
  }
  return lines.filter((l) => INPUT_LINE.test(l)); // no box drawn — best effort
}

/** Production wiring for DispatchDeps. */
const realDeps: DispatchDeps = {
  resolve: findCuratedPaiProject,
  sessions: liveSessions,
  deliver: submitAndConfirm,
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
  const body = `${TASK_PREFIX} ${message}`;

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
    const res = await deps.deliver(existing.id, body, deliverTimeoutMs());
    if (res === "ok") {
      return { outcome: "delivered", project: label, session: existing.label, reason: "" };
    }
    return {
      outcome: "unreachable",
      project: label,
      session: existing.label,
      reason: `Live session found but ${ackReason(res)}.`,
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

  let itermSessionId: string;
  try {
    ({ itermSessionId } = await deps.launch(project));
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

  // Booting can eat the whole budget. Say so, rather than attempting a delivery
  // with no time left and blaming the session for not answering.
  if (left() <= 0) {
    return {
      outcome: "unreachable",
      project: label,
      session: label,
      reason:
        `Launched a session in ${project.rootPath} and it came up, but the ` +
        `${Math.round((budgetMs ?? 0) / 1000)}s budget was spent getting there, ` +
        `leaving none to deliver in. Raise the timeout.`,
    };
  }

  const res = await deps.deliver(itermSessionId, body, deliverTimeoutMs());
  if (res === "ok") {
    return { outcome: "spawned", project: label, session: label, reason: "" };
  }
  // Deliberately NOT "spawned": the tab exists but the work order never landed,
  // and reporting success here is how a task silently disappears.
  return {
    outcome: "unreachable",
    project: label,
    session: label,
    reason: `Spawned a session but ${ackReason(res)}.`,
  };
}
