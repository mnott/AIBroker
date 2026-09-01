/**
 * daemon/subscribe-issues.ts — "subscribe me to that repository's issues".
 *
 * Binding a tracker to a session took two manual steps and a secret carried by
 * hand: create an inbound route at the terminal, then paste its secret into the
 * forge's webhook form. Both are easy to get wrong in ways that fail silently —
 * a route pointed at the wrong session delivers to someone else's mailbox, and
 * a mistyped secret answers 404 exactly like a route that does not exist.
 *
 * So this does both halves from one call, and the secret never leaves the
 * daemon.
 *
 * **The session may only subscribe ITSELF, and that is the whole security
 * argument.** `docs/inbound.md` rests on one property: a caller cannot choose
 * which session runs with the operator's rights, because "a route names its
 * session; the payload never does". A session binding its OWN mailbox does not
 * weaken that — the target is still not chosen by whoever calls the webhook,
 * and a session that could already read its mailbox gains nothing by being able
 * to fill it. What would weaken it is a target parameter, so there is not one:
 * `owner` comes from the caller's resolved identity and is never read from the
 * request. See `subscribeIssues` and the trial in the test that plants one.
 *
 * The route name is derived from the repository rather than supplied, for two
 * reasons. The CLI asks callers to "name routes after their SOURCE, not a
 * topic" and nothing enforced it. And a derived name makes the call idempotent:
 * `addRoute` updates a route of the same name in place and keeps its secret, so
 * subscribing twice re-points the route instead of accumulating duplicates.
 */

/** What a Gitea issue or comment event carries that is worth reading. */
export const ISSUE_FIELDS = [
  "action",
  "issue.number",
  "issue.title",
  "issue.labels",
  "issue.assignees",
  "comment.body",
  "issue.body",
  "comment.html_url",
  "issue.html_url",
  "sender.login",
  "issue.state",
];

export interface RepoRef {
  /** Scheme and host, e.g. `https://git.example.org`. */
  origin: string;
  /** Owning user or organisation, as written. */
  owner: string;
  /** Repository name, as written. */
  repo: string;
}

/**
 * Pull the forge, owner and repository out of whatever the operator pasted.
 *
 * Accepts the browser URL with or without a trailing slash, a `.git` clone URL,
 * and a deep link to an issue — because those are what a person actually has in
 * the clipboard, and refusing them means they retype a URL they already had.
 * Returns null rather than throwing: an unparseable string is an answer.
 */
export function parseRepoUrl(input: string): RepoRef | null {
  const trimmed = (input ?? "").trim();
  if (!trimmed) return null;
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, "");
  if (!owner || !repo) return null;
  return { origin: u.origin, owner, repo };
}

/**
 * The route name for a repository. Deterministic, so the same repository always
 * lands on the same route and a second subscribe updates rather than duplicates.
 *
 * Lowercased and reduced to the characters `addRoute` keeps, so that the name
 * this returns is the name that gets stored — a name mangled on the way in
 * would break the idempotence the derivation exists to provide.
 */
export function routeNameFor(ref: RepoRef): string {
  return `${ref.owner}-${ref.repo}`.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
}

/**
 * Which forge this is.
 *
 * Only the REGISTRATION differs between them. What arrives afterwards does not:
 * both send `action`, `issue.number`, `issue.title`, `comment.body`,
 * `sender.login` and the rest under the same names, which is why one field list
 * serves both and why the inbound half needed no forge knowledge at all.
 *
 * Decided from the host rather than asked for, because the operator pasting a
 * repository URL already said which forge it is and being asked again is a
 * question with a knowable answer.
 */
export type Forge = "github" | "gitea";

/**
 * "gitea" here means the Gitea API SHAPE, not the product. Forgejo is a fork and
 * serves the same surface: the instance this was written against answers
 * `/api/v1/version` with `12.0.4+gitea-1.22.0` — Forgejo 12, declaring Gitea
 * 1.22 compatibility in its own version string. That was read from the server
 * rather than assumed, and it is why one branch covers both.
 */
export function forgeOf(ref: RepoRef): Forge {
  return /(^|\.)github\.com$/i.test(new URL(ref.origin).hostname) ? "github" : "gitea";
}

/**
 * Where the forge expects a hook to be created for this repository.
 *
 * GitHub's API lives on a different host from the browser URL; every other
 * forge here is Gitea-shaped and serves its API from the same origin. Anything
 * self-hosted and unrecognised is treated as Gitea, which is the right guess on
 * this network and fails visibly rather than silently if it is wrong.
 */
export function hooksEndpoint(ref: RepoRef): string {
  const path = `repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/hooks`;
  return forgeOf(ref) === "github"
    ? `https://api.github.com/${path}`
    : `${ref.origin}/api/v1/${path}`;
}

/**
 * The body the forge wants for a webhook on issues and their comments.
 *
 * `active: true` is stated rather than left to a default in both shapes: a hook
 * created inactive looks exactly like a working one in the list and never
 * fires, which is the failure this module exists to stop being silent.
 */
export function hookPayload(ref: RepoRef, url: string, secret: string): Record<string, unknown> {
  const events = ["issues", "issue_comment"];
  if (forgeOf(ref) === "github") {
    return {
      name: "web",
      active: true,
      events,
      config: { url, content_type: "json", secret, insecure_ssl: "0" },
    };
  }
  return {
    type: "gitea",
    active: true,
    events,
    config: { url, content_type: "json", secret, http_method: "post" },
  };
}

/** Where a comment is posted, and where it is read back from. */
export function commentsEndpoint(ref: RepoRef, issue: number): string {
  const path = `repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/issues/${issue}/comments`;
  return forgeOf(ref) === "github"
    ? `https://api.github.com/${path}`
    : `${ref.origin}/api/v1/${path}`;
}

export interface CommentOutcome {
  ok: boolean;
  /** The address the forge gave the comment. Proof it exists, and the link a report should carry. */
  url?: string;
  /** What the server holds now, read back rather than echoed from the request. */
  body?: string;
  error?: string;
}

/**
 * Post a comment, then READ IT BACK.
 *
 * The read-back is not belt and braces. A network call returns and carries on;
 * a post that failed while the caller believed it succeeded is invisible until
 * somebody needs what it said — which is the same fault as a check that passes
 * having measured nothing, in its most expensive form, because the missing
 * thing is a record somebody is relying on. Borrowed from a sibling project's
 * issue tool, which has had this from the start.
 *
 * Returning the URL serves a second purpose: a report naming an issue is
 * required to carry a link, and a link to the comment just written is the
 * honest one. Handing it back means the caller never has to assemble a URL from
 * an issue number, which is a guess wearing the clothes of a citation.
 */
export async function postComment(
  ref: RepoRef,
  issue: number,
  body: string,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<CommentOutcome> {
  if (!token) return { ok: false, error: "no forge token configured — set AIBROKER_FORGE_TOKEN" };
  if (!body.trim()) return { ok: false, error: "refusing to post an empty comment" };

  const url = commentsEndpoint(ref, issue);
  let created: { id?: number; html_url?: string };
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { authorization: `token ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ body }),
    });
    if (res.status !== 201 && res.status !== 200) {
      // Say which of the two it is. A forge answers 404 both for an issue that
      // is not there and for one the credential may not see, and reading the
      // first when it is the second sends people looking for a missing thing
      // that is merely locked.
      const hint =
        res.status === 404
          ? " — the issue does not exist, OR the token cannot see this repository; both answer 404"
          : res.status === 403
            ? " — the token lacks write access to this repository"
            : "";
      return { ok: false, error: `forge answered ${res.status}${hint}` };
    }
    created = (await res.json()) as { id?: number; html_url?: string };
  } catch (e) {
    return { ok: false, error: `forge unreachable: ${(e as Error).message}` };
  }

  // Read back. If this cannot confirm the comment, say the post is unconfirmed
  // rather than reporting success — an unverified write is exactly what this
  // function exists to stop being reported as done.
  try {
    const res = await fetchImpl(`${url}?limit=50`, { headers: { authorization: `token ${token}` } });
    if (res.status === 200) {
      const all = (await res.json()) as Array<{ id?: number; body?: string; html_url?: string }>;
      const mine = all.find((c) => c.id === created.id);
      if (mine) return { ok: true, url: mine.html_url ?? created.html_url, body: mine.body };
    }
    return {
      ok: true,
      url: created.html_url,
      error: "posted, but could not read it back — treat the link as unconfirmed",
    };
  } catch (e) {
    return {
      ok: true,
      url: created.html_url,
      error: `posted, but the read-back failed: ${(e as Error).message}`,
    };
  }
}

export interface SubscribeOutcome {
  ok: boolean;
  /** The route that now exists, whether or not the forge was reached. */
  route?: { name: string; owner: string; url: string };
  /** True when the webhook was registered on the forge for you. */
  registered: boolean;
  /** Why the forge step did not happen, when it did not. */
  reason?: string;
  /** Only when the caller must paste it themselves. */
  secret?: string;
}

/**
 * Register the webhook on the forge.
 *
 * Never throws. A forge that cannot be reached is a partial success worth
 * reporting, not a failure worth losing the route over: the route is the half
 * that cannot be recreated by hand without a new secret, and the hook form is
 * the half that can.
 */
export async function registerHook(
  ref: RepoRef,
  hookUrl: string,
  secret: string,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<{ registered: boolean; reason?: string }> {
  if (!token) {
    return { registered: false, reason: "no forge token configured — add the webhook by hand, once" };
  }
  try {
    const res = await fetchImpl(hooksEndpoint(ref), {
      method: "POST",
      headers: {
        authorization: `token ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(hookPayload(ref, hookUrl, secret)),
    });
    if (res.status === 201 || res.status === 200) return { registered: true };
    // 422 is Gitea's answer to a hook that already exists for this URL. That is
    // the desired end state, so it is not an error — subscribing twice must be
    // safe or the idempotent route naming buys nothing.
    if (res.status === 422) return { registered: true, reason: "already present on the forge" };
    return { registered: false, reason: `forge answered ${res.status}` };
  } catch (e) {
    return { registered: false, reason: `forge unreachable: ${(e as Error).message}` };
  }
}
