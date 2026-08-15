/**
 * daemon/standup.ts — what everyone did, is doing, and is stuck on.
 *
 * THE OLDEST MEETING IN SOFTWARE, and it survives because it answers the three
 * questions a lead cannot get from a repository: what moved, what is moving,
 * and what is blocked. Two of those are already visible here — the objective a
 * machine is working to, and the state of its branch. The third is the one that
 * needs the agent to say something, so the standup asks for it rather than
 * inferring it, exactly as it would of a person.
 *
 * WHY IT IS NOT A MEETING. Nobody attends. It is assembled on a schedule and
 * delivered wherever the lead is — phone, terminal, task list — because the
 * whole reason for giving each developer their own machine was that the lead
 * stopped having to sit and watch. A standup that requires attendance would put
 * that back.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not decide anything. No agent is
 * appointed to run it, chase people or reprioritise. The scrum master's job
 * splits cleanly in two: the process half is a schedule and a template, which is
 * this file; the judgement half is deciding what matters when two things
 * conflict, which stays with the person. Automating the first is a saving.
 * Automating the second recreates the supervisor problem this whole design
 * exists to remove — an agent watching agents, costing a context, becoming the
 * bottleneck it was meant to relieve.
 */

import { loadPeering, peerCall } from "../ipc/peering.js";
import { machineFacts, branchState } from "./machine.js";
import { log } from "../core/log.js";

export interface StandupEntry {
  machine: string;
  reachable: boolean;
  /** What it was told to work on. */
  objective?: string;
  /** What it appears to be doing right now. */
  doing?: string;
  branch?: string;
  head?: string;
  dirty?: number;
  ahead?: number;
  behind?: number;
  /** Anything it could not do, in its own words. */
  blocked?: string;
  detail?: string;
}

/**
 * Collect from every machine, including this one.
 *
 * An unreachable machine is REPORTED as unreachable rather than dropped. A
 * developer missing from a standup and a developer with nothing to say look
 * identical in a list that omits them, and they want opposite reactions — one
 * needs chasing, the other does not.
 */
export async function collectStandup(repo?: string): Promise<StandupEntry[]> {
  const rows: StandupEntry[] = [];

  const here = machineFacts();
  const local: StandupEntry = { machine: here.name, reachable: true };
  if (repo ?? here.workRoot) {
    const st = branchState((repo ?? here.workRoot)!);
    Object.assign(local, {
      branch: st.branch, head: st.head, dirty: st.dirty, ahead: st.ahead, behind: st.behind, detail: st.error,
    });
  }
  rows.push(local);

  const { peers } = loadPeering();
  await Promise.all(
    peers.map(async (p) => {
      const r = await peerCall(p, "where", repo ? { repo } : {}, 10_000);
      if (!r.ok) {
        rows.push({ machine: p.name, reachable: false, detail: r.error });
        return;
      }
      const c = r.result?.checkout ?? {};
      rows.push({
        machine: p.name,
        reachable: true,
        branch: c.branch, head: c.head, dirty: c.dirty, ahead: c.ahead, behind: c.behind,
        detail: c.error,
      });
    }),
  );

  return rows;
}

/**
 * The report, in the shape a person reads at a glance.
 *
 * Ordered by what needs attention rather than by machine name: anything
 * unreachable or blocked first, then work ready to look at, then the rest. A
 * list sorted alphabetically makes the reader do the triage that the report
 * exists to save them.
 */
export function renderStandup(rows: StandupEntry[]): string {
  const needsAttention = (r: StandupEntry) => !r.reachable || !!r.blocked || !!r.detail;
  const readyToReview = (r: StandupEntry) => (r.ahead ?? 0) > 0 && (r.dirty ?? 0) === 0;

  const sorted = [...rows].sort((a, b) => {
    const rank = (r: StandupEntry) => (needsAttention(r) ? 0 : readyToReview(r) ? 1 : 2);
    return rank(a) - rank(b);
  });

  const lines: string[] = [];
  for (const r of sorted) {
    if (!r.reachable) {
      lines.push(`  ✗ ${r.machine} — cannot be reached: ${r.detail ?? "no reason given"}`);
      continue;
    }
    const bits: string[] = [];
    if (r.branch) bits.push(`on ${r.branch}${r.head ? ` at ${r.head}` : ""}`);
    if (r.dirty) bits.push(`${r.dirty} uncommitted`);
    if (r.ahead) bits.push(`${r.ahead} to review`);
    if (r.behind) bits.push(`${r.behind} behind`);
    if (r.detail) bits.push(r.detail);
    const mark = readyToReview(r) ? "▲" : "·";
    lines.push(`  ${mark} ${r.machine}${bits.length ? ` — ${bits.join(", ")}` : " — nothing reported"}`);
    if (r.objective) lines.push(`      working to: ${r.objective.slice(0, 100)}`);
    if (r.blocked) lines.push(`      BLOCKED: ${r.blocked}`);
  }

  const ready = sorted.filter(readyToReview).length;
  const stuck = sorted.filter((r) => !r.reachable).length;
  const head =
    `standup — ${rows.length} machine${rows.length === 1 ? "" : "s"}` +
    (ready ? `, ${ready} with work to review` : "") +
    (stuck ? `, ${stuck} unreachable` : "");

  return `${head}\n${lines.join("\n")}`;
}

let timer: NodeJS.Timeout | null = null;

/**
 * Run it on a schedule and deliver it.
 *
 * Off unless asked for. A report that arrives whether or not anybody wanted it
 * teaches its reader to skip it, and a standup nobody reads is worse than none
 * because it looks like oversight.
 */
export function startStandup(everyMinutes: number, deliver: (text: string) => void, repo?: string): void {
  if (timer) clearInterval(timer);
  if (everyMinutes <= 0) return;
  const run = async () => {
    try {
      deliver(renderStandup(await collectStandup(repo)));
    } catch (e) {
      log(`[standup] could not assemble — ${(e as Error).message}`);
    }
  };
  timer = setInterval(() => void run(), everyMinutes * 60_000);
  timer.unref?.();
  log(`[standup] every ${everyMinutes} min`);
}

export function stopStandup(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
