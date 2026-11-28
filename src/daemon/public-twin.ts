/**
 * daemon/public-twin.ts — forge issue labelled `public` -> neutral GitHub twin.
 *
 * All HTTP is behind injected clients. Nothing is posted to GitHub unless the
 * text passed assertPublicSafe and an operator approved it.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadJson, saveJson } from "../core/json-store.js";
import { assertPublicSafe, checkPublicText, twinBranchName, type SanitizeHit } from "../core/public-sanitizer.js";

export interface TwinEntry {
  forge: number;
  github: number;
  repo: string;
  closed?: boolean;
  seenComments: { forge: number[]; github: number[] };
}

interface TwinState { entries: TwinEntry[]; pulls: number[] }

/** Mapping store over a JSON file; refuses to write when the file is unreadable. */
export class TwinStore {
  private state: TwinState = { entries: [], pulls: [] };
  private blocked: string | undefined;
  constructor(private path: string) {
    const r = loadJson<TwinState>(path);
    if (r.status === "ok") this.state = { entries: r.data.entries ?? [], pulls: r.data.pulls ?? [] };
    else if (r.status === "unreadable") this.blocked = r.error;
  }
  private save(): void {
    if (this.blocked) throw new Error(`twin store unreadable, refusing to write: ${this.blocked}`);
    saveJson(this.path, this.state);
  }
  entries(): TwinEntry[] { return this.state.entries; }
  getByForge(n: number): TwinEntry | undefined { return this.state.entries.find((e) => e.forge === n); }
  getByGithub(n: number): TwinEntry | undefined { return this.state.entries.find((e) => e.github === n); }
  put(e: TwinEntry): void {
    this.state.entries = this.state.entries.filter((x) => x.forge !== e.forge).concat(e);
    this.save();
  }
  markClosed(forge: number): void {
    const e = this.getByForge(forge);
    if (!e) return;
    e.closed = true;
    this.save();
  }
  /** Persist in-place changes made to an entry (seenComments). */
  flush(): void { this.save(); }
  hasPull(n: number): boolean { return this.state.pulls.includes(n); }
  addPull(n: number): void {
    if (!this.state.pulls.includes(n)) this.state.pulls.push(n);
    this.save();
  }
}

export interface ForgeIssue { number: number; title: string; body?: string; labels?: string[] }
export interface ForgeClient {
  getIssue(n: number): Promise<ForgeIssue>;
  comment(n: number, body: string): Promise<void>;
  createIssue(i: { title: string; body: string; labels: string[] }): Promise<{ number: number }>;
  labels(n: number): Promise<string[]>;
}
export interface GhComment { id: number; user: string; body: string }
export interface GhIssue { number: number; title: string; body?: string; user: string; url: string; pullRequest?: boolean }
export interface GhPull { number: number; title: string; user: string; url: string }
export interface GithubClient {
  createIssue(i: { title: string; body: string }): Promise<{ number: number; url: string }>;
  comment(m: number, body: string): Promise<void>;
  closeIssue(m: number): Promise<void>;
  listComments(m: number): Promise<GhComment[]>;
  listNewIssues(sinceIso: string): Promise<GhIssue[]>;
  listPulls(): Promise<GhPull[]>;
  closePull(n: number, body: string): Promise<void>;
}
export interface Git { fetchPr(n: number): Promise<void> }

const run = promisify(execFile);
/** Real Git: `git fetch github pull/<n>/head:gh-pr-<n>` (args array, no shell). */
export function realGit(cwd?: string): Git {
  return {
    async fetchPr(n: number) {
      await run("git", ["fetch", "github", `pull/${n}/head:${twinBranchName(n)}`], { cwd });
    },
  };
}

export interface Draft { ok: boolean; title: string; body: string; hits: SanitizeHit[] }
export interface Override { title: string; body: string }

const TEMPLATE = "Tracking issue mirrored from the project tracker.";

export function draftTwin(issue: ForgeIssue, denyTerms: string[] = [], override?: Override): Draft {
  const title = override?.title ?? issue.title;
  const body = override?.body ?? (issue.body ? `${TEMPLATE}\n\n${issue.body}` : TEMPLATE);
  const t = checkPublicText(title, denyTerms);
  const b = checkPublicText(body, denyTerms);
  const hits = [...t.hits, ...b.hits];
  return { ok: hits.length === 0, title, body, hits };
}

export interface TwinDeps {
  store: TwinStore;
  forge: ForgeClient;
  github: GithubClient;
  repo: string;
  denyTerms?: string[];
  /** Operator approval: true, false, or a rewritten {title, body}. */
  approve?: (draft: Draft) => Promise<boolean | Override>;
  git?: Git;
  now?: () => Date;
}

export interface LabelEvent { action: "labeled" | "unlabeled"; label: string; forgeIssue: ForgeIssue }

export async function onLabelEvent(ev: LabelEvent, deps: TwinDeps): Promise<string> {
  if (ev.label !== "public") return "ignored";
  const n = ev.forgeIssue.number;
  const existing = deps.store.getByForge(n);
  if (ev.action === "unlabeled") {
    if (!existing || existing.closed) return "no-twin";
    await deps.github.comment(existing.github, "This issue is no longer tracked publicly. Closing.");
    await deps.github.closeIssue(existing.github);
    deps.store.markClosed(n);
    return "closed";
  }
  if (existing) return "exists";
  let draft = draftTwin(ev.forgeIssue, deps.denyTerms);
  if (!deps.approve) return "denied";
  const verdict = await deps.approve(draft);
  if (verdict === false) return "denied";
  if (typeof verdict === "object") draft = draftTwin(ev.forgeIssue, deps.denyTerms, verdict);
  else if (!draft.ok) return "refused";
  if (!draft.ok) return "refused";
  assertPublicSafe(draft.title, deps.denyTerms);
  assertPublicSafe(draft.body, deps.denyTerms);
  const gh = await deps.github.createIssue({ title: draft.title, body: draft.body });
  deps.store.put({ forge: n, github: gh.number, repo: deps.repo, seenComments: { forge: [], github: [] } });
  await deps.forge.comment(n, `Public twin: ${gh.url}`);
  return "created";
}

export async function syncComments(deps: TwinDeps): Promise<number> {
  let posted = 0;
  for (const e of deps.store.entries()) {
    if (e.closed) continue;
    for (const c of await deps.github.listComments(e.github)) {
      if (e.seenComments.github.includes(c.id)) continue;
      await deps.forge.comment(e.forge, `From GitHub (@${c.user}): ${c.body}`);
      e.seenComments.github.push(c.id);
      deps.store.flush();
      posted++;
    }
  }
  return posted;
}

/** Explicit forge -> GitHub reply; refuses on any sanitizer hit. */
export async function replyToTwin(forgeNumber: number, text: string, deps: TwinDeps): Promise<void> {
  const e = deps.store.getByForge(forgeNumber);
  if (!e || e.closed) throw new Error(`no open twin for forge #${forgeNumber}`);
  assertPublicSafe(text, deps.denyTerms);
  await deps.github.comment(e.github, text);
}

export async function syncNewGithubIssues(deps: TwinDeps, sinceIso = "1970-01-01T00:00:00Z"): Promise<number> {
  let made = 0;
  for (const i of await deps.github.listNewIssues(sinceIso)) {
    if (i.pullRequest || deps.store.getByGithub(i.number)) continue;
    const body = `Opened on GitHub by @${i.user}: ${i.url}\n\n${i.body ?? ""}`;
    const f = await deps.forge.createIssue({ title: i.title, body, labels: ["public", "from-github"] });
    deps.store.put({ forge: f.number, github: i.number, repo: deps.repo, seenComments: { forge: [], github: [] } });
    made++;
  }
  return made;
}

export async function syncPulls(deps: TwinDeps): Promise<number> {
  if (!deps.git) throw new Error("git dependency required");
  let made = 0;
  for (const p of await deps.github.listPulls()) {
    if (deps.store.hasPull(p.number)) continue;
    await deps.git.fetchPr(p.number);
    const branch = twinBranchName(p.number);
    await deps.forge.createIssue({
      title: `Review GitHub PR #${p.number}`,
      body: `PR by @${p.user}: ${p.url}\n\nTitle: ${p.title}\nBranch: ${branch}`,
      labels: ["from-github"],
    });
    deps.store.addPull(p.number);
    made++;
  }
  return made;
}

export async function onMergedPr(prNumber: number, mergeSha: string, repoUrl: string, deps: TwinDeps): Promise<void> {
  const body = `Merged. Thank you! ${repoUrl}/commit/${mergeSha}`;
  assertPublicSafe(body, deps.denyTerms);
  await deps.github.closePull(prNumber, body);
}
