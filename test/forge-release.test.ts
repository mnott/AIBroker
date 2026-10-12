import { test } from "node:test";
import assert from "node:assert/strict";
import { closedIssue, decideRelease, releaseClosed, releaseOnClose, type ReleaseClient } from "../src/daemon/forge-release.js";

const claimed = {
  assignees: [{ login: "claude" }, { login: "someone" }],
  labels: [{ id: 7, name: "in-progress" }, { id: 8, name: "bug" }],
};

function fake(issue: unknown) {
  const calls: string[] = [];
  const client: ReleaseClient = {
    get: async (p) => { calls.push(`GET ${p}`); return issue; },
    patch: async (p, b) => { calls.push(`PATCH ${p} ${JSON.stringify(b)}`); },
    del: async (p) => { calls.push(`DELETE ${p}`); },
  };
  return { client, calls };
}

const closed = { action: "closed", issue: { number: 5 } };

test("closed with both removes assignee and label", async () => {
  const { client, calls } = fake(claimed);
  await releaseClosed(closed, client);
  assert.deepEqual(calls, ["GET /issues/5", 'PATCH /issues/5 {"assignees":["someone"]}', "DELETE /issues/5/labels/7"]);
});

test("closed with only the label removes the label only", async () => {
  const { client, calls } = fake({ assignees: [], labels: claimed.labels });
  await releaseClosed(closed, client);
  assert.deepEqual(calls, ["GET /issues/5", "DELETE /issues/5/labels/7"]);
});

test("closed with only the assignee removes the assignee only", async () => {
  const { client, calls } = fake({ assignees: [{ login: "claude" }], labels: [] });
  await releaseClosed(closed, client);
  assert.deepEqual(calls, ["GET /issues/5", 'PATCH /issues/5 {"assignees":[]}']);
});

test("already clean makes no write calls", async () => {
  const { client, calls } = fake({ assignees: [{ login: "x" }], labels: [{ id: 1, name: "bug" }] });
  assert.equal(await releaseClosed(closed, client), undefined);
  assert.deepEqual(calls, ["GET /issues/5"]);
});

test("reopened, edited and pull requests do nothing", async () => {
  for (const p of [
    { action: "reopened", issue: { number: 5 } },
    { action: "edited", issue: { number: 5 } },
    { action: "closed", issue: { number: 5, pull_request: {} } },
    { action: "closed", pull_request: { number: 5 } },
    { action: "closed" },
  ]) {
    assert.equal(closedIssue(p), undefined);
    const { client, calls } = fake(claimed);
    await releaseClosed(p, client);
    assert.deepEqual(calls, []);
  }
});

test("decideRelease is empty for a clean issue", () => {
  assert.deepEqual(decideRelease({ assignees: [], labels: [] }), {});
});

test("releaseOnClose never throws and refuses a mismatched repo", async () => {
  const payload = { ...closed, repository: { html_url: "https://forge.example/apps/demo" } };
  const seen: string[] = [];
  const f = (async (url: string, init: any) => {
    seen.push(`${init.method} ${url}`);
    return new Response(JSON.stringify(init.method === "GET" ? claimed : {}), { status: 200 });
  }) as unknown as typeof fetch;
  await releaseOnClose("apps/other", payload, "tok", f);
  assert.deepEqual(seen, []);
  await releaseOnClose("apps/demo", payload, "tok", f);
  assert.equal(seen.length, 3);
  assert.match(seen[2], /^DELETE .*\/repos\/apps\/demo\/issues\/5\/labels\/7$/);
  const boom = (async () => { throw new Error("down"); }) as unknown as typeof fetch;
  await releaseOnClose("apps/demo", payload, "tok", boom);
});
