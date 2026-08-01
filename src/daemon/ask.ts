/**
 * daemon/ask.ts — put a question to a project's session and wait for its answer.
 *
 * Sibling to `dispatch`, for a caller with no session and no mailbox: a plain
 * CLI poller run by launchd that needs to know whether the session it handed
 * work to is still alive.
 *
 * NEVER spawns. A probe that creates the thing it is probing for turns a dead
 * session into a fresh one and reports health.
 *
 * ── Why there is a fourth outcome ───────────────────────────────────────────
 *
 * The requested contract had three: replied / not running / no reply in time.
 * Implementing it revealed those cannot be told apart from the case that
 * matters most. Claude Code QUEUES typed input while it is mid-turn and only
 * reads it when the current turn ends, which can be many minutes. So a healthy
 * session busy doing exactly the work it was given produces the same silence as
 * a wedged one, and a short timeout reports it as "no reply".
 *
 * That is not an edge case for this caller — the scheduler probes at expected
 * duration x 1.5, i.e. precisely when the session is most likely still working.
 * Every probe of a slow-but-fine task would read as stuck.
 *
 * So `ask` checks liveness BEFORE injecting anything: a session whose screen is
 * changing is working, which is the answer the caller wanted, and it is
 * returned without sending a question at all. That also removes the probe's
 * token cost in the common case, which is the pressure PAI asked the contract
 * to apply.
 *
 *   replied  — it answered; `reply` holds its words
 *   busy     — mid-turn and progressing. ALIVE. Nothing was sent.
 *   silent   — idle, took the question, never answered. Genuinely suspicious.
 *   absent   — no live session for that project
 *
 * `busy` must NOT count toward a stuck threshold; it is positive evidence of
 * life. `silent` is the one that should.
 */

import { findCuratedPaiProject, type PaiProject } from "./pai-projects.js";
import { findSessionForProject, type LiveSession } from "./dispatch.js";
import { snapshotAllSessions } from "../transport/sync-facade.js";
import { getAllPersistentSessionNames, lookupPersistentName } from "../core/persistence.js";
import {
  flatten,
  inputBoxStart,
  hasBeenSubmitted,
  isClaudeReady,
  realIO,
  type TerminalIO,
} from "./terminal-screen.js";
import { log } from "../core/log.js";

export type AskState = "replied" | "busy" | "silent" | "absent";

export interface AskResult {
  /** True only when the session actually answered. */
  replied: boolean;
  /** Resolved session label, or "" when none is running. */
  session: string;
  /** The session's answer. Present only when replied. */
  reply?: string;
  /** Why not, when it did not answer. */
  reason?: string;
  /** Machine-readable outcome; additive to the boolean above. */
  state: AskState;
}

export interface AskOptions {
  /** Total budget for the whole probe. */
  timeoutMs?: number;
}

export interface AskDeps {
  resolve: (name: string) => Promise<PaiProject | undefined>;
  sessions: () => LiveSession[];
  io: TerminalIO;
}

const DEFAULT_TIMEOUT_MS = 60_000;
/** Two samples this far apart decide working-vs-idle. */
export const LIVENESS_SAMPLE_MS = 1_500;
/** Quiet samples that mean the answer is finished. */
const SETTLE_TICKS = 4;
const POLL_MS = 500;

/** Enumerate live sessions with persistent names resolved. */
function liveSessions(): LiveSession[] {
  const persistent = getAllPersistentSessionNames();
  return snapshotAllSessions().map((s) => ({
    id: s.id,
    name: s.name,
    paiName: lookupPersistentName(persistent, s.id, s.aibrokerId),
  }));
}

export const realAskDeps: AskDeps = {
  resolve: findCuratedPaiProject,
  sessions: liveSessions,
  io: realIO,
};

/**
 * Extract the session's answer: everything added below the echoed question and
 * above the input box.
 *
 * Anchored on the LAST line still matching the question, because Claude echoes
 * the question into the transcript and a long one wraps over several lines —
 * without that, the session's own echo reads back as its reply.
 */
export function extractReply(frame: string, question: string): string {
  const lines = frame.split("\n");
  const needle = flatten(question).slice(0, 24);

  let lastEcho = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (needle && flatten(lines[i]).includes(needle)) { lastEcho = i; break; }
  }

  // The echo wraps; skip its continuation lines too.
  if (lastEcho >= 0) {
    const qWords = flatten(question).split(" ").filter((w) => w.length > 3);
    let j = lastEcho + 1;
    while (j < lines.length) {
      const f = flatten(lines[j]);
      if (!f) { j++; continue; }
      const overlap = qWords.filter((w) => f.includes(w)).length;
      if (overlap > 0 && overlap >= Math.min(3, qWords.length)) { j++; continue; }
      break;
    }
    lastEcho = j - 1;
  }

  const boxAt = inputBoxStart(frame);
  const end = boxAt >= 0 ? boxAt : lines.length;
  const body = lines.slice(lastEcho + 1, end);

  return body
    // Filter BEFORE stripping markers: the marker IS the signal. Claude prefixes
    // real output with ⏺ and its elapsed-time status with ✻ ("✻ Cogitated for
    // 49s", "✻ Vibing… (3m 27s · ↓ 11.6k tokens)"). Strip the glyph first and
    // the status line becomes ordinary prose that reads as part of the answer.
    .filter((l) => !/^\s*[✻✳]/.test(l))
    // `⎿` marks a tool-result continuation ("⎿  1 skill available") — Claude's
    // rendering, never the prose we asked for. Observed leaking into a live probe.
    .filter((l) => !/^\s*⎿/.test(l))
    .map((l) => l.replace(/^\s*[⏺*]\s?/, "").trimEnd())
    .filter((l) => !/^\s*$/.test(l))
    .join("\n")
    .trim();
}

/** True when two samples of the screen differ — the session is producing output. */
async function isWorking(id: string, io: TerminalIO): Promise<boolean> {
  const a = io.capture(id);
  if (a === null) return false;
  await io.sleep(LIVENESS_SAMPLE_MS);
  const b = io.capture(id);
  if (b === null) return false;
  return a !== b;
}

export async function ask(
  projectName: string,
  question: string,
  opts: AskOptions = {},
  deps: AskDeps = realAskDeps,
): Promise<AskResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = deps.io.now();
  const left = () => Math.max(0, timeoutMs - (deps.io.now() - startedAt));

  const project = await deps.resolve(projectName);
  if (!project) {
    return {
      replied: false,
      session: "",
      state: "absent",
      reason:
        `No curated alias for "${projectName}", so no session could be identified. ` +
        `Register one with \`pai project name <identifier> ${projectName}\`.`,
    };
  }

  const label = project.displayName || project.name;
  const existing = findSessionForProject(project, deps.sessions());
  if (!existing) {
    // Deliberately not launched: a probe must never create what it is probing.
    return { replied: false, session: "", state: "absent", reason: "session not running" };
  }

  // ── liveness first, so a working session is never interrupted ──
  if (await isWorking(existing.id, deps.io)) {
    return {
      replied: false,
      session: existing.label,
      state: "busy",
      reason:
        "session is mid-turn and still producing output, so it cannot read a question yet — " +
        "nothing was sent. This is evidence of life, not of being stuck.",
    };
  }

  const frame = deps.io.capture(existing.id);
  if (frame === null) {
    return { replied: false, session: existing.label, state: "silent", reason: "session terminal could not be read" };
  }
  if (!isClaudeReady(frame)) {
    return {
      replied: false,
      session: existing.label,
      state: "silent",
      reason: "session is not showing a Claude prompt (it may have exited to a shell)",
    };
  }

  // ── idle: ask, confirm the question landed, then wait for the answer ──
  deps.io.send(existing.id, question);

  const needle = flatten(question).slice(0, 48);
  let submitted = false;
  const submitDeadline = deps.io.now() + Math.min(10_000, timeoutMs);
  while (deps.io.now() < submitDeadline) {
    await deps.io.sleep(POLL_MS);
    const f = deps.io.capture(existing.id);
    if (f !== null && hasBeenSubmitted(f, needle)) { submitted = true; break; }
  }
  if (!submitted) {
    return {
      replied: false,
      session: existing.label,
      state: "silent",
      reason: "the question was typed but the session never accepted it",
    };
  }

  // Answer complete when the screen stops changing.
  let last = deps.io.capture(existing.id) ?? "";
  let quiet = 0;
  while (left() > 0) {
    await deps.io.sleep(POLL_MS);
    const cur = deps.io.capture(existing.id);
    if (cur === null) continue;
    if (cur === last) {
      if (++quiet >= SETTLE_TICKS) {
        const reply = extractReply(cur, question);
        if (!reply) {
          return {
            replied: false,
            session: existing.label,
            state: "silent",
            reason: "session took the question but produced no answer",
          };
        }
        log(`ask: ${label} answered in ${Math.round((deps.io.now() - startedAt) / 1000)}s`);
        return { replied: true, session: existing.label, state: "replied", reply };
      }
    } else {
      quiet = 0;
      last = cur;
    }
  }

  return {
    replied: false,
    session: existing.label,
    state: "silent",
    reason: `no reply within ${Math.round(timeoutMs / 1000)}s`,
  };
}
