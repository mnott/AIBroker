/**
 * daemon/todoist-claims.ts — releasing a claim nobody came back for.
 *
 * The webhook claims a trigger before dispatching it, so two mechanisms
 * watching one checkbox cannot both fire. That is correct while the run is
 * alive and a trap when it is not: a session that dies mid-turn leaves the task
 * claimed, the webhook then skips it, and the trigger is dead until a human
 * notices a routine that quietly stopped running. Permanent silence is worse
 * than a duplicate — it is the failure this whole subsystem exists to prevent.
 *
 * PAI's poller ages its own claims. This exists so the webhook path does not
 * DEPEND on that: a machine running the webhook trigger with no poller must
 * still recover. Releasing twice is harmless — removing an absent label is a
 * no-op — so two releasers converge, where two dispatchers would not. The
 * window here is deliberately longer than PAI's, so its more informed decision
 * lands first and this is only ever the backstop.
 *
 * Elapsed time only, never "the session looks gone". The hub has returned an
 * empty session list while nineteen sessions were running; a recovery that
 * trusts that spawns a duplicate per task. Three hours of wall clock is not a
 * matter of opinion.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { loadJson, saveJson } from "../core/json-store.js";
import { audit } from "./audit.js";
import { log } from "../core/log.js";

const FILE = join(homedir(), ".aibroker", "todoist-claims.json");

/**
 * The invariant, and why it is not a constant.
 *
 * A flat window cannot stay behind an adaptive one. PAI releases at
 * max(expected x 10, 120 min); a flat 180 min sat BEHIND it only for tasks
 * expected to run under 18 minutes, and in front of it for every real routine —
 * so the less informed release fired first. A four-hour sweep would have had
 * its claim released at three hours, and the next poll, seeing an unclaimed
 * overdue task, would have dispatched a second run alongside the first: the
 * duplicate the interlock exists to prevent, produced by the backstop.
 *
 * The honest bound is not a duration at all. A claim must not survive INTO THE
 * NEXT SCHEDULED RUN — past that point the next trigger arrives and the claim
 * blocks it, which is the silence again. So the deadline is the next occurrence
 * itself, which Todoist has already told us: on completion of a recurring task
 * the due date has advanced, and the payload carries it.
 *
 * That is always outside any per-task timer shorter than one period, without
 * having to guess anyone else's arithmetic.
 */
export const CLAIM_DEADLINE_MARGIN_MS = 5 * 60 * 1000;

/** A run is allowed to be slow. Nothing is released in its first two hours. */
export const CLAIM_MIN_AGE_MS = 2 * 60 * 60 * 1000;

/** Used only when the next occurrence is unknown — comfortably past PAI's default. */
export const CLAIM_FALLBACK_AGE_MS = 12 * 60 * 60 * 1000;

interface ClaimRecord {
  claimedAt: string;
  /** Next occurrence, when the payload carried one. */
  nextDue?: string;
}

interface Store { claims: Record<string, ClaimRecord | string> }

function read(): Store {
  const r = loadJson<Store>(FILE);
  if (r.status === "ok" && r.data?.claims) return r.data;
  return { claims: {} };
}

export function recordClaim(
  taskId: string,
  at: string = new Date().toISOString(),
  nextDue?: string,
): void {
  if (!taskId) return;
  const s = read();
  s.claims[taskId] = { claimedAt: at, nextDue };
  saveJson(FILE, s);
}

/** Tolerates the pre-0.17.3 shape, where a claim was a bare timestamp. */
function asRecord(v: ClaimRecord | string): ClaimRecord {
  return typeof v === "string" ? { claimedAt: v } : v;
}

export function forgetClaim(taskId: string): void {
  const s = read();
  if (!(taskId in s.claims)) return;
  delete s.claims[taskId];
  saveJson(FILE, s);
}

export function listClaims(): Array<{ taskId: string; claimedAt: string; nextDue?: string }> {
  const s = read();
  return Object.entries(s.claims).map(([taskId, v]) => ({ taskId, ...asRecord(v) }));
}

/**
 * When a claim stops being credible.
 *
 * The next occurrence, less a small margin, so the claim is gone before the
 * trigger it would block. With no known occurrence, a flat twelve hours —
 * chosen to clear an adaptive poller's default rather than to be right.
 */
export function claimDeadline(c: { claimedAt: string; nextDue?: string }): number {
  const claimed = Date.parse(c.claimedAt);
  const floor = claimed + CLAIM_MIN_AGE_MS;
  const due = c.nextDue ? Date.parse(c.nextDue) : NaN;
  const deadline = Number.isFinite(due)
    ? due - CLAIM_DEADLINE_MARGIN_MS
    : claimed + CLAIM_FALLBACK_AGE_MS;
  // A run is allowed to be slow even when the next occurrence is close.
  return Math.max(deadline, floor);
}

/** Claims whose deadline has passed — whatever took them is not coming back. */
export function expiredClaims(now: number = Date.now()): Array<{ taskId: string; ageMs: number }> {
  return listClaims()
    .filter((c) => Number.isFinite(Date.parse(c.claimedAt)) && now >= claimDeadline(c))
    .map((c) => ({ taskId: c.taskId, ageMs: now - Date.parse(c.claimedAt) }));
}

/**
 * Release every claim nobody came back for.
 *
 * `release` is injected so the sweep is testable without Todoist, and so a
 * failed release leaves the record in place to be retried next time rather than
 * forgetting a claim that is still on the task.
 */
export async function sweepAbandonedClaims(
  release: (taskId: string) => Promise<void>,
  now: number = Date.now(),
): Promise<string[]> {
  const released: string[] = [];
  for (const { taskId, ageMs } of expiredClaims(now)) {
    try {
      await release(taskId);
      forgetClaim(taskId);
      released.push(taskId);
      const mins = Math.round(ageMs / 60000);
      audit({
        action: "todoist-claim", actor: "aibroker", target: `todoist:task:${taskId}`,
        outcome: "released", reason: `claimed ${mins} min ago and never released — trigger reopened`,
      });
      log(`todoist-claims: released a ${mins} min old claim on ${taskId}`);
    } catch (e) {
      log(`todoist-claims: could not release ${taskId} — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return released;
}

/**
 * May this claim be released yet?
 *
 * The risk being guarded is precise: a task that is UNCLAIMED AND OVERDUE is
 * ordinary overdue work, and the next poll dispatches it. So a session that
 * drops its claim before the completion lands makes the same run happen again,
 * looking spontaneous. Finishing is two steps that are not atomic and the
 * ordering is not ours to enforce, so we check the state instead of trusting it.
 *
 * The test is therefore "is the task still overdue", not "has the due date
 * advanced past the occurrence I recorded". The first version compared against
 * the recorded occurrence, which breaks the moment anything legitimately moves
 * the date BACKWARDS — PAI restores the occurrence a manual trigger consumed,
 * so a schedule repair would have made this refuse a release on a run that
 * genuinely finished. A stuck claim caused by a correct repair.
 *
 * Refusing inverts the failure in the direction both sides agreed on: a claim
 * stuck until a timer releases it, rather than a run nobody asked for.
 */
export function mayRelease(taskId: string, currentDue: string | undefined): { ok: true } | { ok: false; reason: string } {
  const claim = listClaims().find((c) => c.taskId === taskId);
  // Nothing recorded: there is no in-flight run to protect.
  if (!claim) return { ok: true };
  // Cannot tell — no due date, or the task could not be read. Allow it: a guard
  // that strands a session unable to clear its own claim is the same silence
  // one step along.
  if (!currentDue) return { ok: true };

  const due = Date.parse(currentDue);
  if (!Number.isFinite(due)) return { ok: true };
  if (due > Date.now()) return { ok: true };

  return {
    ok: false,
    reason:
      "the task is still overdue, so the completion has not landed. Complete it first, then " +
      "release: dropping the claim while it is overdue leaves ordinary overdue work behind, " +
      "and the next poll would run it again.",
  };
}
