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

/** Longer than PAI's 120-minute floor, so the better-informed release wins. */
export const CLAIM_MAX_AGE_MS = 3 * 60 * 60 * 1000;

interface Store { claims: Record<string, string> }

function read(): Store {
  const r = loadJson<Store>(FILE);
  if (r.status === "ok" && r.data?.claims) return r.data;
  return { claims: {} };
}

export function recordClaim(taskId: string, at: string = new Date().toISOString()): void {
  if (!taskId) return;
  const s = read();
  s.claims[taskId] = at;
  saveJson(FILE, s);
}

export function forgetClaim(taskId: string): void {
  const s = read();
  if (!(taskId in s.claims)) return;
  delete s.claims[taskId];
  saveJson(FILE, s);
}

export function listClaims(): Array<{ taskId: string; claimedAt: string }> {
  const s = read();
  return Object.entries(s.claims).map(([taskId, claimedAt]) => ({ taskId, claimedAt }));
}

/** Claims old enough that whatever took them is not coming back. */
export function expiredClaims(now: number = Date.now()): Array<{ taskId: string; ageMs: number }> {
  return listClaims()
    .map((c) => ({ taskId: c.taskId, ageMs: now - Date.parse(c.claimedAt) }))
    .filter((c) => Number.isFinite(c.ageMs) && c.ageMs >= CLAIM_MAX_AGE_MS);
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
