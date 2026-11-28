/**
 * daemon/twin-watch.ts — one idempotent watcher tick for public twins.
 */

import { onLabelEvent, onMergedPr, syncComments, syncNewGithubIssues, syncPulls, type TwinDeps } from "./public-twin.js";

export interface TwinTickResult {
  created: number; closed: number; comments: number; issues: number; pulls: number; closedPulls: number;
  errors: string[];
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function twinTick(deps: TwinDeps, opts: { repoUrl: string; sinceIso?: string }): Promise<TwinTickResult> {
  const r: TwinTickResult = { created: 0, closed: 0, comments: 0, issues: 0, pulls: 0, closedPulls: 0, errors: [] };
  const step = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); } catch (e) { r.errors.push(`${name}: ${msg(e)}`); }
  };

  await step("labels", async () => {
    if (!deps.forge.listPublicIssues) return;
    const pub = await deps.forge.listPublicIssues();
    const pubNums = new Set(pub.map((i) => i.number));
    for (const issue of pub) {
      const e = deps.store.getByForge(issue.number);
      if (e && !e.closed) continue;
      await step(`label #${issue.number}`, async () => {
        const res = await onLabelEvent({ action: "labeled", label: "public", forgeIssue: issue }, deps);
        if (res === "created") r.created++;
      });
    }
    for (const e of [...deps.store.entries()]) {
      if (e.closed || pubNums.has(e.forge)) continue;
      await step(`unlabel #${e.forge}`, async () => {
        const res = await onLabelEvent({ action: "unlabeled", label: "public", forgeIssue: { number: e.forge, title: "" } }, deps);
        if (res === "closed") r.closed++;
      });
    }
  });
  await step("comments", async () => { r.comments = await syncComments(deps); });
  await step("issues", async () => { r.issues = await syncNewGithubIssues(deps, opts.sinceIso); });
  const git = deps.git;
  if (git) {
    await step("pulls", async () => { r.pulls = await syncPulls(deps); });
    if (git.mergeShaFor) {
      for (const n of deps.store.pulls()) {
        if (deps.store.isPullClosed(n)) continue;
        await step(`merged #${n}`, async () => {
          const sha = await git.mergeShaFor!(n);
          if (!sha) return;
          await onMergedPr(n, sha, opts.repoUrl, deps);
          deps.store.markPullClosed(n);
          r.closedPulls++;
        });
      }
    }
  }
  return r;
}
