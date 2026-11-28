import { test } from "node:test";
import assert from "node:assert/strict";
import { githubHttpClient, forgeHttpClient } from "../src/daemon/twin-http.js";

type Call = { url: string; method: string; body?: any; auth?: string };
function fake(responses: Array<{ status?: number; json?: unknown }>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: any) => {
    calls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers.authorization });
    const r = responses.shift() ?? {};
    return { status: r.status ?? 200, json: async () => r.json } as any;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}
const TOKEN = "s3cret-tok";

test("github: create/comment/close/list/pulls", async () => {
  const f = fake([
    { json: { number: 5, html_url: "https://gh/5" } }, {}, {},
    { json: [{ id: 1, user: { login: "a" }, body: "hi" }] },
    { json: [{ number: 7, title: "t", user: { login: "u" }, html_url: "x" }, { number: 8, title: "p", user: { login: "u" }, html_url: "y", pull_request: {} }] },
    { json: [{ number: 9, title: "pr", user: { login: "u" }, html_url: "z" }] },
    {}, {},
  ]);
  const c = githubHttpClient({ repo: "o/n", token: TOKEN, fetchImpl: f.fetchImpl });
  assert.deepEqual(await c.createIssue({ title: "T", body: "B" }), { number: 5, url: "https://gh/5" });
  await c.comment(5, "c");
  await c.closeIssue(5);
  assert.deepEqual(await c.listComments(5), [{ id: 1, user: "a", body: "hi" }]);
  const iss = await c.listNewIssues("2026-01-01T00:00:00Z");
  assert.equal(iss[0].pullRequest, undefined);
  assert.equal(iss[1].pullRequest, true);
  assert.equal((await c.listPulls())[0].number, 9);
  await c.closePull(9, "merged");
  const u = f.calls.map((x) => `${x.method} ${x.url}`);
  assert.equal(u[0], "POST https://api.github.com/repos/o/n/issues");
  assert.equal(u[1], "POST https://api.github.com/repos/o/n/issues/5/comments");
  assert.equal(u[2], "PATCH https://api.github.com/repos/o/n/issues/5");
  assert.deepEqual(f.calls[2].body, { state: "closed" });
  assert.equal(u[3], "GET https://api.github.com/repos/o/n/issues/5/comments");
  assert.match(u[4], /\/issues\?state=open&since=2026-01-01T00%3A00%3A00Z&sort=created/);
  assert.equal(u[5], "GET https://api.github.com/repos/o/n/pulls?state=open");
  assert.equal(u[6], "POST https://api.github.com/repos/o/n/issues/9/comments");
  assert.equal(u[7], "PATCH https://api.github.com/repos/o/n/pulls/9");
  assert.deepEqual(f.calls[0].body, { title: "T", body: "B" });
  for (const x of f.calls) {
    assert.equal(x.auth, `token ${TOKEN}`);
    assert.ok(!x.url.includes(TOKEN));
  }
});

test("forge: issues, comments, labels", async () => {
  const f = fake([
    { json: { number: 3, title: "T", body: "B", labels: [{ name: "public" }] } }, {},
    { json: { number: 4 } }, { json: [{ name: "public" }, { name: "x" }] },
  ]);
  const c = forgeHttpClient({ baseUrl: "https://forge.test/", repo: "APPS/R", token: TOKEN, fetchImpl: f.fetchImpl });
  assert.deepEqual(await c.getIssue(3), { number: 3, title: "T", body: "B", labels: ["public"] });
  await c.comment(3, "hello");
  assert.deepEqual(await c.createIssue({ title: "a", body: "b", labels: ["l"] }), { number: 4 });
  assert.deepEqual(await c.labels(3), ["public", "x"]);
  const u = f.calls.map((x) => `${x.method} ${x.url}`);
  assert.equal(u[0], "GET https://forge.test/api/v1/repos/APPS/R/issues/3");
  assert.equal(u[1], "POST https://forge.test/api/v1/repos/APPS/R/issues/3/comments");
  assert.deepEqual(f.calls[1].body, { body: "hello" });
  assert.equal(u[2], "POST https://forge.test/api/v1/repos/APPS/R/issues");
  assert.deepEqual(f.calls[2].body, { title: "a", body: "b", labels: ["l"] });
  assert.equal(u[3], "GET https://forge.test/api/v1/repos/APPS/R/issues/3/labels");
  for (const x of f.calls) assert.ok(x.auth && !x.url.includes(TOKEN));
});

test("non-2xx throws status and path only, no token", async () => {
  const f = fake([{ status: 401, json: { message: TOKEN } }, { status: 500 }]);
  const g = githubHttpClient({ repo: "o/n", token: TOKEN, fetchImpl: f.fetchImpl });
  await assert.rejects(g.closeIssue(2), (e: Error) => /PATCH \/issues\/2/.test(e.message) && /401/.test(e.message) && !e.message.includes(TOKEN));
  const c = forgeHttpClient({ baseUrl: "https://f.test", repo: "a/b", token: TOKEN, fetchImpl: f.fetchImpl });
  await assert.rejects(c.labels(1), (e: Error) => /500/.test(e.message) && !e.message.includes(TOKEN));
});
