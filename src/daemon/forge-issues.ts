/**
 * daemon/forge-issues.ts — the issue tracker, for a session that receives from it.
 *
 * A sibling project already had all of this as a repo-local script whose token
 * lives in that repository's git config. It works, and it is the right shape
 * for a session working inside one checkout. It cannot help a session that
 * receives events for a tracker it has no clone of, which is the case this
 * exists for: the permission travels with the SUBSCRIPTION rather than with a
 * checkout, so a session may act on a tracker precisely when it is the one
 * being told about it.
 *
 * Three things are taken from that script deliberately rather than reinvented,
 * because each was learned the expensive way:
 *
 * **Every write reads itself back.** A network call returns and carries on. A
 * post that failed while the caller believed it succeeded is invisible until
 * somebody needs what it said — the same fault as a check that passes having
 * measured nothing, in its costliest form, because what is missing is a record
 * being relied upon.
 *
 * **404 is ambiguous and must be said so.** A forge answers 404 both for an
 * issue that does not exist and for one the credential cannot see. Reporting
 * the first when it is the second sends a reader looking for a missing thing
 * that is merely locked; twenty minutes went that way in one afternoon.
 *
 * **Closing is custody, not capability.** Receiving events about a tracker is
 * not owning what is in it. Closing is therefore restricted to issues this
 * account opened; anything else can be reported as fixed and left for a person.
 */

import { forgeOf, type RepoRef } from "./subscribe-issues.js";

/** Read-only verbs — safe to run against anything the subscription covers. */
export type ReadVerb = "get" | "comments" | "list" | "labels" | "assets";
/** Verbs that change the tracker. */
export type WriteVerb =
  | "new" | "comment" | "amend" | "rewrite" | "retitle"
  | "label" | "unlabel" | "claim" | "release" | "close";
export type IssueVerb = ReadVerb | WriteVerb;

export const READ_VERBS: ReadVerb[] = ["get", "comments", "list", "labels", "assets"];
export const WRITE_VERBS: WriteVerb[] = [
  "new", "comment", "amend", "rewrite", "retitle", "label", "unlabel", "claim", "release", "close",
];

/** The API root for a repository, on either forge shape. */
export function apiRoot(ref: RepoRef): string {
  const path = `repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
  return forgeOf(ref) === "github" ? `https://api.github.com/${path}` : `${ref.origin}/api/v1/${path}`;
}

/**
 * What a status code means here, in words a reader can act on.
 *
 * 404 gets the ambiguity spelled out because the two causes need opposite
 * responses: one is "the number is wrong", the other is "the token cannot see
 * this", and a bare "Not Found" reads as the first every time.
 */
export function explain(status: number): string {
  if (status === 404) {
    return "404 — the issue or repository does not exist, OR the token cannot see it; a forge answers both the same way";
  }
  if (status === 403) return "403 — the token lacks the access this needs";
  if (status === 401) return "401 — the token was refused; it may be expired";
  if (status === 422) return "422 — the forge rejected the content as invalid";
  return `${status}`;
}

export interface IssueResult {
  ok: boolean;
  /** What the server holds, read back after a write rather than echoed. */
  data?: unknown;
  /** The address of what was written, for a report that must carry a link. */
  url?: string;
  error?: string;
  /** Set when the write landed but could not be confirmed. */
  warning?: string;
  /**
   * Which issue this touched, when the caller did not name one.
   *
   * `amend` is given a COMMENT id, so the daemon cannot know from the request
   * which issue was written to — and what it cannot name, it cannot remember,
   * so the echo of an edit came straight back to its own session. The forge
   * says which issue a comment belongs to; this carries that answer back.
   */
  issue?: number;
}

export interface Ctx {
  ref: RepoRef;
  token: string;
  fetchImpl: typeof fetch;
  /** The account the session posts as, for custody checks. */
  botLogin?: string;
  /** Who to name in the signature on written text. The session, not the account. */
  authorLabel?: string;
}

/**
 * The Authorization header.
 *
 * Two credential shapes are in use and both must work. An API token goes as
 * `token <t>`. A user and password pair goes as Basic — which is what the
 * sibling project's script uses, and what somebody arriving from it will have.
 * Written as `user:secret` when it contains a colon, so one setting covers both
 * without a second variable to forget.
 */
export function authHeader(credential: string): string {
  const i = credential.indexOf(":");
  if (i <= 0) return `token ${credential}`;
  return "Basic " + Buffer.from(credential).toString("base64");
}

async function call(
  c: Ctx,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json?: unknown }> {
  const res = await c.fetchImpl(`${apiRoot(c.ref)}${path}`, {
    method,
    headers: {
      authorization: authHeader(c.token),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    json = undefined;
  }
  return { status: res.status, json };
}

/**
 * Who the credential actually is, asked of the forge.
 *
 * There used to be a configured account name here, set by hand, and on the
 * first live write it was WRONG: the variable said one account, the token
 * belonged to another. Both rules that depend on identity failed silently and
 * in opposite directions. The route's self-ignore filtered a name that never
 * arrived, so a session's own comment came back to it as something new to
 * consider — measured two seconds after the write, in the audit trail. And the
 * custody rule on `close` compared against a name that opened nothing, so it
 * would have refused every issue for a reason that was not true.
 *
 * A name that describes a credential has no business being typed twice. The
 * forge knows, so it is asked, once per token, and the configured value is
 * only a fallback for a forge that will not say.
 */
const identityCache = new Map<string, string | undefined>();

export async function whoAmI(c: Ctx): Promise<string | undefined> {
  const key = `${new URL(c.ref.origin).host}|${c.token}`;
  if (identityCache.has(key)) return identityCache.get(key);
  let login: string | undefined;
  try {
    const base = forgeOf(c.ref) === "github" ? "https://api.github.com/user" : `${c.ref.origin}/api/v1/user`;
    const res = await c.fetchImpl(base, { headers: { authorization: authHeader(c.token) } });
    if (res.status === 200) {
      const j = (await res.json()) as { login?: string };
      if (typeof j?.login === "string" && j.login) login = j.login;
    }
  } catch {
    /* a forge that will not answer leaves the fallback in place */
  }
  const resolved = login ?? c.botLogin;
  identityCache.set(key, resolved);
  return resolved;
}

/** Forget cached identities. For tests, and for a rotated credential. */
export function forgetIdentities(): void {
  identityCache.clear();
}

/**
 * Say, in the record itself, that a session wrote this.
 *
 * Where the sessions and the operator share one credential — the ordinary case
 * until somebody sets up a separate bot account — every comment carries the
 * same author, and the tracker keeps no trace of which were written by a person.
 * Permission does not care: that rests on the subscription. A reader in six
 * months does, and they have only the ticket. Raised by the session that had
 * just written its first comment and noticed its own was indistinguishable from
 * the two above it.
 *
 * Appended rather than prefixed, so the author's own first line stays their
 * first line, and marked so a re-read can recognise and replace it instead of
 * stacking a second copy on a rewrite.
 */
const SIGNATURE_MARK = "\u{1F916}";

export function signature(author: string): string {
  return `${SIGNATURE_MARK} ${author} · aibroker`;
}


/** The session named in a body’s trailing signature, if it carries one. */
export function signedAuthor(body: string): string | undefined {
  const lines = body.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  const last = lines[lines.length - 1];
  if (!last || !last.startsWith(SIGNATURE_MARK)) return undefined;
  const rest = last.slice(SIGNATURE_MARK.length).trim();
  const at = rest.lastIndexOf(" · ");
  return at > 0 ? rest.slice(0, at).trim() : undefined;
}

/** The issue number inside a comment’s issue_url, if the forge gave one. */
export function issueOfComment(c: { issue_url?: string }): number | undefined {
  const m = /\/issues\/(\d+)(?:$|[?#])/.exec(c.issue_url ?? "");
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Strip a signature this wrote earlier, so rewrites do not accumulate them. */
export function unsign(body: string): string {
  const lines = body.split("\n");
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  if (lines.length && lines[lines.length - 1].startsWith(SIGNATURE_MARK)) {
    lines.pop();
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  }
  return lines.join("\n");
}

/**
 * The body as it should be stored: the author's text, then the signature.
 *
 * Signing happens AFTER the emptiness check upstream, deliberately. A body that
 * is only a signature is an empty comment wearing a hat, and refusing it is the
 * point of that check.
 */
export function sign(body: string, author: string | undefined): string {
  if (!author) return body;
  return `${unsign(body)}\n\n${signature(author)}`;
}

/**
 * Every page of a listing.
 *
 * The forge answers fifty by default and says nothing about the rest. A listing
 * that silently stops at fifty is worse than one that refuses: it looks like a
 * complete answer, and "there are no more open issues" is exactly the kind of
 * false reading somebody acts on. Taken from the sibling script, which learned
 * it first.
 */
async function allPages(c: Ctx, path: string, limit = 50): Promise<unknown[]> {
  const joiner = path.includes("?") ? "&" : "?";
  const out: unknown[] = [];
  for (let page = 1; ; page += 1) {
    const r = await call(c, "GET", `${path}${joiner}limit=${limit}&page=${page}`);
    if (r.status !== 200 || !Array.isArray(r.json) || r.json.length === 0) break;
    out.push(...r.json);
    if (r.json.length < limit) break;
  }
  return out;
}

/** Fetch an issue, so a write can be checked against what is actually there. */
async function readIssue(c: Ctx, n: number): Promise<{ status: number; issue?: any }> {
  const r = await call(c, "GET", `/issues/${n}`);
  return { status: r.status, issue: r.json as any };
}

/**
 * Run one verb.
 *
 * Every write path ends by reading the thing back and returning what the server
 * holds. Where the read-back fails, the result says the write is UNCONFIRMED
 * rather than reporting plain success — an unverified write reported as done is
 * the failure this whole module is shaped around.
 */
export async function issueOp(
  verb: IssueVerb,
  args: { issue?: number; comment?: number; body?: string; title?: string; label?: string; state?: string; count?: number },
  ctx: { ref: RepoRef; token?: string; botLogin?: string; authorLabel?: string; fetchImpl?: typeof fetch },
): Promise<IssueResult> {
  if (!ctx.token) return { ok: false, error: "no forge token configured — set AIBROKER_FORGE_TOKEN" };
  const c: Ctx = { ref: ctx.ref, token: ctx.token, botLogin: ctx.botLogin, authorLabel: ctx.authorLabel, fetchImpl: ctx.fetchImpl ?? fetch };
  const n = args.issue;

  const needsNumber = (): string | undefined =>
    n && n > 0 ? undefined : `${verb} needs an issue number`;

  switch (verb) {
    case "list": {
      const q = new URLSearchParams({ state: args.state ?? "open" });
      if (args.label) q.set("labels", args.label);
      // Every page: fifty silently returned as if it were all of them is the
      // failure this guards, and it reads exactly like a complete answer.
      const items = (await allPages(c, `/issues?${q}`)) as any[];
      // Who opened each one travels with the list, because that is the
      // difference between an issue this session may close and one it may only
      // report as fixed.
      const rows = items.map((i) => ({
        number: i.number, title: i.title, state: i.state,
        opened_by: i.user?.login, labels: (i.labels ?? []).map((l: any) => l.name),
        url: i.html_url,
      }));
      return { ok: true, data: rows };
    }
    case "labels": {
      const r = await call(c, "GET", "/labels");
      if (r.status !== 200) return { ok: false, error: explain(r.status) };
      return { ok: true, data: (r.json as any[]).map((l) => l.name) };
    }
    case "get": {
      const bad = needsNumber(); if (bad) return { ok: false, error: bad };
      const r = await readIssue(c, n!);
      if (r.status !== 200) return { ok: false, error: explain(r.status) };
      // Chosen fields, not the forge's whole object. Two reasons, and the
      // second is the one that matters: the raw shape nests a full user record
      // under `user`, which carries an EMAIL ADDRESS — a person's, arriving in
      // a session's context and from there into whatever it writes. Nothing
      // here needs it. A login says who opened the issue, which is the only
      // question this answers.
      const i = r.issue as any;
      return {
        ok: true,
        url: i.html_url,
        data: {
          number: i.number, title: i.title, state: i.state, body: i.body,
          opened_by: i.user?.login,
          labels: (i.labels ?? []).map((l: any) => l.name),
          assignees: (i.assignees ?? []).map((a: any) => a.login),
          created_at: i.created_at, updated_at: i.updated_at,
          url: i.html_url,
        },
      };
    }
    case "comments": {
      const bad = needsNumber(); if (bad) return { ok: false, error: bad };
      // Paged, and this one is sharper than the listing: unpaged, `count`
      // slices the end of the FIRST FIFTY, so "the newest two" on a long
      // thread silently returns the 49th and 50th oldest — an answer that is
      // wrong while looking exactly like the right one.
      const all = (await allPages(c, `/issues/${n}/comments`)) as any[];
      const take = args.count && args.count > 0 ? all.slice(-args.count) : all;
      return { ok: true, data: take.map((x) => ({ by: x.user?.login, body: x.body, url: x.html_url })) };
    }
    case "assets": {
      const bad = needsNumber(); if (bad) return { ok: false, error: bad };
      const r = await call(c, "GET", `/issues/${n}/assets`);
      if (r.status !== 200) return { ok: false, error: explain(r.status) };
      return { ok: true, data: r.json };
    }
    case "new": {
      if (!args.title?.trim()) return { ok: false, error: "new needs a title" };
      const r = await call(c, "POST", "/issues", { title: args.title, body: sign(args.body ?? "", c.authorLabel) });
      if (r.status !== 201) return { ok: false, error: explain(r.status) };
      const made = r.json as any;
      const back = await readIssue(c, made.number);
      if (back.status !== 200) {
        return { ok: true, url: made.html_url, warning: "opened, but could not be read back — treat as unconfirmed" };
      }
      return { ok: true, url: back.issue.html_url, issue: back.issue.number, data: { number: back.issue.number, title: back.issue.title } };
    }
    case "comment": {
      const bad = needsNumber(); if (bad) return { ok: false, error: bad };
      if (!args.body?.trim()) return { ok: false, error: "refusing to post an empty comment" };
      const r = await call(c, "POST", `/issues/${n}/comments`, { body: sign(args.body, c.authorLabel) });
      if (r.status !== 201 && r.status !== 200) return { ok: false, error: explain(r.status) };
      const made = r.json as any;
      const back = await call(c, "GET", `/issues/${n}/comments`);
      if (back.status === 200) {
        const mine = (back.json as any[]).find((x) => x.id === made.id);
        if (mine) return { ok: true, url: mine.html_url, data: { body: mine.body } };
      }
      return { ok: true, url: made.html_url, warning: "posted, but could not be read back — treat the link as unconfirmed" };
    }
    case "amend": {
      /*
       * Correct a comment already written.
       *
       * The gap this closes was found by falling into it: an issue body could
       * be rewritten but a comment could not, so a sentence that turned out to
       * be wrong could only be answered with another comment. On a ticket
       * somebody reads later, a correction that trails the mistake by three
       * entries is worse than a corrected entry.
       *
       * Two custody checks, and the second is the one that matters here. The
       * forge only lets a credential edit its own comments — but where sessions
       * share one credential, "its own" covers everybody's. So a comment whose
       * signature names a DIFFERENT session is refused: sharing an account is
       * not sharing authorship, and quietly editing another session's record is
       * the kind of thing that is noticed late and cannot be undone.
       */
      const id = args.comment;
      if (!id || id <= 0) return { ok: false, error: "amend needs the comment id (--comment N)" };
      if (!args.body?.trim()) return { ok: false, error: "amend needs a body" };

      const cur = await call(c, "GET", `/issues/comments/${id}`);
      if (cur.status !== 200) return { ok: false, error: explain(cur.status) };
      const existing = cur.json as { body?: string; user?: { login?: string }; issue_url?: string };
      // Which issue this belongs to, so the edit can be recognised as our own
      // when the forge reports it back a minute later.
      const belongsTo = issueOfComment(existing);

      const me = await whoAmI(c);
      if (!me || existing.user?.login !== me) {
        return { ok: false, error: `comment ${id} was written by ${existing.user?.login ?? "someone else"} — not yours to edit` };
      }
      const signedBy = signedAuthor(existing.body ?? "");
      if (signedBy && c.authorLabel && signedBy !== c.authorLabel) {
        return {
          ok: false,
          error: `comment ${id} is signed by "${signedBy}", not by you — a shared account is not shared authorship; ask them, or add your own comment`,
        };
      }

      const r = await call(c, "PATCH", `/issues/comments/${id}`, { body: sign(args.body, c.authorLabel) });
      if (r.status !== 200 && r.status !== 201) return { ok: false, error: explain(r.status) };
      const back = await call(c, "GET", `/issues/comments/${id}`);
      if (back.status !== 200) {
        return { ok: true, issue: belongsTo, warning: "amended, but could not be read back — treat as unconfirmed" };
      }
      const now = back.json as { body?: string; html_url?: string };
      return { ok: true, url: now.html_url, issue: belongsTo, data: { body: now.body } };
    }
    case "rewrite": {
      const bad = needsNumber(); if (bad) return { ok: false, error: bad };
      if (!args.body?.trim()) return { ok: false, error: "rewrite needs a body" };
      const r = await call(c, "PATCH", `/issues/${n}`, { body: sign(args.body, c.authorLabel) });
      if (r.status !== 201 && r.status !== 200) return { ok: false, error: explain(r.status) };
      const back = await readIssue(c, n!);
      return back.status === 200
        ? { ok: true, url: back.issue.html_url, data: { body: back.issue.body } }
        : { ok: true, warning: "rewritten, but could not be read back — treat as unconfirmed" };
    }
    case "retitle": {
      const bad = needsNumber(); if (bad) return { ok: false, error: bad };
      if (!args.title?.trim()) return { ok: false, error: "retitle needs a title" };
      const r = await call(c, "PATCH", `/issues/${n}`, { title: args.title });
      if (r.status !== 201 && r.status !== 200) return { ok: false, error: explain(r.status) };
      const back = await readIssue(c, n!);
      return back.status === 200
        ? { ok: true, url: back.issue.html_url, data: { title: back.issue.title } }
        : { ok: true, warning: "retitled, but could not be read back — treat as unconfirmed" };
    }
    case "label":
    case "unlabel": {
      const bad = needsNumber(); if (bad) return { ok: false, error: bad };
      if (!args.label) return { ok: false, error: `${verb} needs a label name` };
      const all = await call(c, "GET", "/labels");
      if (all.status !== 200) return { ok: false, error: explain(all.status) };
      const found = (all.json as any[]).find((l) => l.name === args.label);
      if (!found) {
        return { ok: false, error: `no label "${args.label}" on this repository — labels are created by a person, not invented here` };
      }
      const r =
        verb === "label"
          ? await call(c, "POST", `/issues/${n}/labels`, { labels: [found.id] })
          : await call(c, "DELETE", `/issues/${n}/labels/${found.id}`);
      if (r.status >= 300) return { ok: false, error: explain(r.status) };
      const back = await readIssue(c, n!);
      return back.status === 200
        ? { ok: true, url: back.issue.html_url, data: { labels: (back.issue.labels ?? []).map((l: any) => l.name) } }
        : { ok: true, warning: `${verb} applied, but could not be read back — treat as unconfirmed` };
    }
    case "claim":
    case "release": {
      const bad = needsNumber(); if (bad) return { ok: false, error: bad };
      const me = await whoAmI(c);
      if (!me) {
        return { ok: false, error: `${verb} needs to know which account you are, and the forge would not say` };
      }
      const cur = await readIssue(c, n!);
      if (cur.status !== 200) return { ok: false, error: explain(cur.status) };
      const held: string[] = (cur.issue.assignees ?? []).map((a: any) => a.login);
      if (verb === "claim" && held.length && !held.includes(me)) {
        // Not ours to take. Somebody else is on it, and quietly reassigning
        // work is the kind of thing that is noticed late and resented.
        return { ok: false, error: `already assigned to ${held.join(", ")} — not yours to take` };
      }
      const next = verb === "claim" ? [me] : held.filter((h) => h !== me);
      const r = await call(c, "PATCH", `/issues/${n}`, { assignees: next });
      if (r.status >= 300) return { ok: false, error: explain(r.status) };
      const back = await readIssue(c, n!);
      return back.status === 200
        ? { ok: true, url: back.issue.html_url, data: { assignees: (back.issue.assignees ?? []).map((a: any) => a.login) } }
        : { ok: true, warning: `${verb} applied, but could not be read back — treat as unconfirmed` };
    }
    case "close": {
      const bad = needsNumber(); if (bad) return { ok: false, error: bad };
      const cur = await readIssue(c, n!);
      if (cur.status !== 200) return { ok: false, error: explain(cur.status) };
      // Custody, not capability. Receiving events about a tracker is not owning
      // what is in it: an issue a person opened is theirs to close, and the most
      // this session may do is say it is fixed and leave the tick to them.
      const author = cur.issue.user?.login;
      const me = await whoAmI(c);
      if (!me || author !== me) {
        return {
          ok: false,
          error: `#${n} was opened by ${author ?? "someone else"}, so closing it is theirs — comment that it is fixed and leave the tick`,
        };
      }
      const r = await call(c, "PATCH", `/issues/${n}`, { state: "closed" });
      if (r.status >= 300) return { ok: false, error: explain(r.status) };
      const back = await readIssue(c, n!);
      return back.status === 200
        ? { ok: true, url: back.issue.html_url, data: { state: back.issue.state } }
        : { ok: true, warning: "closed, but could not be read back — treat as unconfirmed" };
    }
    default:
      return { ok: false, error: `unknown verb "${verb}"` };
  }
}
