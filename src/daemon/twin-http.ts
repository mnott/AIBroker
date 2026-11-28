/**
 * Real HTTP clients for the public-twin interfaces (GitHub REST v3 and
 * Gitea/Forgejo v1). fetch is injected; the token only ever goes in the
 * Authorization header and never into URLs or error messages.
 */
import { authHeader } from "./forge-issues.js";
import type { ForgeClient, ForgeIssue, GithubClient, GhComment, GhIssue, GhPull } from "./public-twin.js";

export interface TwinHttpOpts {
  baseUrl?: string;
  /** "owner/name" */
  repo: string;
  token: string;
  fetchImpl?: typeof fetch;
}

type J = Record<string, any>;

function make(o: TwinHttpOpts, base: string, prefix: string) {
  const f = o.fetchImpl ?? fetch;
  const root = `${base.replace(/\/+$/, "")}${prefix}/repos/${o.repo.split("/").map(encodeURIComponent).join("/")}`;
  return async function req(method: string, path: string, body?: unknown): Promise<any> {
    const res = await f(`${root}${path}`, {
      method,
      headers: {
        authorization: authHeader(o.token),
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`${method} ${path.split("?")[0]} failed: HTTP ${res.status}`);
    }
    if (res.status === 204) return undefined;
    try {
      return await res.json();
    } catch {
      return undefined;
    }
  };
}

export function githubHttpClient(o: TwinHttpOpts): GithubClient {
  const req = make(o, o.baseUrl ?? "https://api.github.com", "");
  return {
    async createIssue(i) {
      const r: J = await req("POST", "/issues", { title: i.title, body: i.body });
      return { number: r.number, url: r.html_url };
    },
    async comment(m, body) {
      await req("POST", `/issues/${m}/comments`, { body });
    },
    async closeIssue(m) {
      await req("PATCH", `/issues/${m}`, { state: "closed" });
    },
    async listComments(m): Promise<GhComment[]> {
      const r: J[] = await req("GET", `/issues/${m}/comments`);
      return r.map((c) => ({ id: c.id, user: c.user?.login ?? "", body: c.body ?? "" }));
    },
    async listNewIssues(since): Promise<GhIssue[]> {
      const q = `?state=open&since=${encodeURIComponent(since)}&sort=created&direction=asc`;
      const r: J[] = await req("GET", `/issues${q}`);
      return r.map((i) => ({
        number: i.number,
        title: i.title,
        body: i.body ?? undefined,
        user: i.user?.login ?? "",
        url: i.html_url,
        ...(i.pull_request ? { pullRequest: true } : {}),
      }));
    },
    async listPulls(): Promise<GhPull[]> {
      const r: J[] = await req("GET", "/pulls?state=open");
      return r.map((p) => ({ number: p.number, title: p.title, user: p.user?.login ?? "", url: p.html_url }));
    },
    async closePull(n, body) {
      await req("POST", `/issues/${n}/comments`, { body });
      await req("PATCH", `/pulls/${n}`, { state: "closed" });
    },
  };
}

export function forgeHttpClient(o: TwinHttpOpts & { baseUrl: string }): ForgeClient {
  const req = make(o, o.baseUrl, "/api/v1");
  const names = (l: J[] | undefined) => (l ?? []).map((x) => x.name as string);
  return {
    async getIssue(n): Promise<ForgeIssue> {
      const r: J = await req("GET", `/issues/${n}`);
      return { number: r.number, title: r.title, body: r.body ?? undefined, labels: names(r.labels) };
    },
    async comment(n, body) {
      await req("POST", `/issues/${n}/comments`, { body });
    },
    async createIssue(i) {
      const r: J = await req("POST", "/issues", { title: i.title, body: i.body, labels: i.labels });
      return { number: r.number };
    },
    async labels(n) {
      return names(await req("GET", `/issues/${n}/labels`));
    },
  };
}
