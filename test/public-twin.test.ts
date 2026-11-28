import "./home-guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TwinStore, onLabelEvent, syncComments, syncNewGithubIssues, syncPulls, onMergedPr, replyToTwin, type TwinDeps } from "../src/daemon/public-twin.js";

function mk(approve: TwinDeps["approve"] = async () => true) {
  const calls: string[] = [];
  const forgeComments: Array<[number, string]> = [];
  const forgeIssues: any[] = [];
  const ghComments: any[] = [{ id: 1, user: "bob", body: "hi" }];
  const closedPulls: Array<[number, string]> = [];
  let ghIssues: any[] = [];
  const deps: TwinDeps = {
    store: new TwinStore(join(mkdtempSync(join(tmpdir(), "twin-")), "t.json")),
    repo: "o/r",
    approve,
    forge: {
      getIssue: async () => ({ number: 1, title: "" }),
      comment: async (n, b) => { forgeComments.push([n, b]); },
      createIssue: async (i) => { forgeIssues.push(i); return { number: 100 + forgeIssues.length }; },
      labels: async () => [],
    },
    github: {
      createIssue: async (i) => { calls.push("create"); return { number: 7, url: "https://github.com/o/r/issues/7" }; },
      comment: async () => { calls.push("comment"); },
      closeIssue: async () => { calls.push("close"); },
      listComments: async () => ghComments,
      listNewIssues: async () => ghIssues,
      listPulls: async () => [{ number: 5, title: "fix", user: "al", url: "https://github.com/o/r/pull/5" }],
      closePull: async (n, b) => { closedPulls.push([n, b]); },
    },
    git: { fetchPr: async (n) => { calls.push(`fetch gh-pr-${n}`); } },
  };
  return { deps, calls, forgeComments, forgeIssues, closedPulls, setIssues: (x: any[]) => { ghIssues = x; } };
}
const issue = (body = "Add dark mode") => ({ number: 3, title: "Dark mode", body });
const lab = (o: any = {}) => ({ action: "labeled" as const, label: "public", forgeIssue: issue(), ...o });

test("unrelated label ignored", async () => {
  const m = mk();
  assert.equal(await onLabelEvent(lab({ label: "bug" }), m.deps), "ignored");
  assert.deepEqual(m.calls, []);
});

test("labeled+approved creates neutral twin, mapping, forge link", async () => {
  const m = mk();
  assert.equal(await onLabelEvent(lab(), m.deps), "created");
  assert.equal(m.deps.store.getByForge(3)?.github, 7);
  assert.match(m.forgeComments[0][1], /github\.com\/o\/r\/issues\/7/);
  assert.equal(await onLabelEvent(lab(), m.deps), "exists");
  assert.deepEqual(m.calls, ["create"]);
});

test("approval denied -> no GitHub call", async () => {
  const m = mk(async () => false);
  assert.equal(await onLabelEvent(lab(), m.deps), "denied");
  assert.deepEqual(m.calls, []);
});

test("site details refused", async () => {
  for (const body of ["host 10.0.0.5 down", "see /Users/x/f", "git.mnsoft.org broke"]) {
    const m = mk();
    assert.equal(await onLabelEvent(lab({ forgeIssue: issue(body) }), m.deps), "refused");
    assert.deepEqual(m.calls, []);
  }
});

test("operator override accepted, but still sanitized", async () => {
  const m = mk(async () => ({ title: "Dark mode", body: "Clean text" }));
  assert.equal(await onLabelEvent(lab({ forgeIssue: issue("10.0.0.5") }), m.deps), "created");
  const m2 = mk(async () => ({ title: "t", body: "10.0.0.5" }));
  assert.equal(await onLabelEvent(lab(), m2.deps), "refused");
  assert.deepEqual(m2.calls, []);
});

test("unlabeled closes twin", async () => {
  const m = mk();
  await onLabelEvent(lab(), m.deps);
  assert.equal(await onLabelEvent(lab({ action: "unlabeled" }), m.deps), "closed");
  assert.deepEqual(m.calls, ["create", "comment", "close"]);
  assert.equal(m.deps.store.getByForge(3)?.closed, true);
});

test("comment sync once only", async () => {
  const m = mk();
  await onLabelEvent(lab(), m.deps);
  assert.equal(await syncComments(m.deps), 1);
  assert.equal(await syncComments(m.deps), 0);
  assert.ok(m.forgeComments.some(([, b]) => b === "From GitHub (@bob): hi"));
});

test("new GitHub issue -> forge issue, no dupes, PRs skipped", async () => {
  const m = mk();
  m.setIssues([{ number: 9, title: "bug", body: "b", user: "eve", url: "https://github.com/o/r/issues/9" }, { number: 10, title: "pr", user: "x", url: "u", pullRequest: true }]);
  assert.equal(await syncNewGithubIssues(m.deps), 1);
  assert.equal(await syncNewGithubIssues(m.deps), 0);
  assert.deepEqual(m.forgeIssues[0].labels, ["public", "from-github"]);
  assert.match(m.forgeIssues[0].body, /@eve/);
});

test("PR fetched and reviewed once", async () => {
  const m = mk();
  assert.equal(await syncPulls(m.deps), 1);
  assert.equal(await syncPulls(m.deps), 0);
  assert.deepEqual(m.calls, ["fetch gh-pr-5"]);
  assert.equal(m.forgeIssues.length, 1);
  assert.equal(m.forgeIssues[0].title, "Review GitHub PR #5");
  assert.match(m.forgeIssues[0].body, /gh-pr-5/);
  assert.deepEqual(m.forgeIssues[0].labels, ["from-github"]);
});

test("merged PR close carries commit link", async () => {
  const m = mk();
  await onMergedPr(5, "abc123", "https://github.com/o/r", m.deps);
  assert.match(m.closedPulls[0][1], /https:\/\/github\.com\/o\/r\/commit\/abc123/);
});

test("replyToTwin refuses a path", async () => {
  const m = mk();
  await onLabelEvent(lab(), m.deps);
  await assert.rejects(replyToTwin(3, "look at /Users/me/x", m.deps));
  await replyToTwin(3, "thanks", m.deps);
  assert.deepEqual(m.calls, ["create", "comment"]);
});
