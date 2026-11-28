import "./home-guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TwinStore, onLabelEvent, syncComments, syncNewGithubIssues, syncPulls, onMergedPr, replyToTwin, draftTwin, type TwinDeps, type ForgeIssue } from "../src/daemon/public-twin.js";
import { twinTick } from "../src/daemon/twin-watch.js";

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
  for (const t of ["host 10.0.0.5 down", "see /Users/x/f", "git.mnsoft.org broke"]) {
    const m = mk();
    assert.equal(await onLabelEvent(lab({ forgeIssue: { number: 3, title: t, body: "x" } }), m.deps), "refused");
    assert.deepEqual(m.calls, []);
  }
});

test("default draft never carries the raw forge body", () => {
  const d = draftTwin({ number: 3, title: "Dark mode", body: "secret 10.0.0.5 details" });
  assert.ok(d.ok);
  assert.ok(!d.body.includes("secret"));
  assert.match(d.body, /Dark mode/);
});

function tickDeps(pub: ForgeIssue[], mergeSha: () => string | undefined = () => undefined) {
  const m = mk();
  const state = { pub };
  m.deps.forge.listPublicIssues = async () => state.pub;
  m.deps.git = { fetchPr: async () => {}, mergeShaFor: async () => mergeSha() };
  return { ...m, state };
}
const opts = { repoUrl: "https://github.com/o/r" };

test("tick: label add -> twin, label removed -> closed, idempotent", async () => {
  const t = tickDeps([issue()]);
  const r1 = await twinTick(t.deps, opts);
  assert.equal(r1.created, 1);
  assert.equal(t.deps.store.getByForge(3)?.github, 7);
  const r2 = await twinTick(t.deps, opts);
  assert.equal(r2.created, 0);
  assert.equal(r2.closed, 0);
  assert.equal(r2.comments, 0);
  assert.equal(r2.pulls, 0);
  t.state.pub = [];
  const r3 = await twinTick(t.deps, opts);
  assert.equal(r3.closed, 1);
  assert.equal(t.deps.store.getByForge(3)?.closed, true);
  assert.equal((await twinTick(t.deps, opts)).closed, 0);
});

test("tick: merged PR closed once with commit link", async () => {
  let sha: string | undefined;
  const t = tickDeps([], () => sha);
  assert.equal((await twinTick(t.deps, opts)).pulls, 1);
  assert.equal(t.closedPulls.length, 0);
  sha = "abc123";
  assert.equal((await twinTick(t.deps, opts)).closedPulls, 1);
  assert.equal((await twinTick(t.deps, opts)).closedPulls, 0);
  assert.equal(t.closedPulls.length, 1);
  assert.match(t.closedPulls[0][1], /github\.com\/o\/r\/commit\/abc123/);
});

test("tick: failing comment sync does not block PR closing", async () => {
  const t = tickDeps([issue()], () => "abc123");
  t.deps.github.listComments = async () => { throw new Error("boom"); };
  const r = await twinTick(t.deps, opts);
  assert.equal(r.closedPulls, 1);
  assert.ok(r.errors.some((e) => e.startsWith("comments:")));
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

test("relabel after unlabel opens a fresh twin instead of staying closed", async () => {
  const m = mk();
  await onLabelEvent(lab(), m.deps);
  await onLabelEvent(lab({ action: "unlabeled" }), m.deps);
  assert.equal(await onLabelEvent(lab(), m.deps), "created");
  assert.equal(m.deps.store.getByForge(3)?.closed, undefined);
});

test("retry after crash between createIssue and store.put reuses existing twin (no duplicate)", async () => {
  const m = mk();
  const created: any[] = [];
  m.deps.github.createIssue = async (i) => { created.push(i); return { number: 7, url: "https://github.com/o/r/issues/7" }; };
  m.deps.github.findIssueByMarker = async (marker) => {
    const hit = created.find((c) => c.body.includes(marker));
    return hit ? { number: 7, url: "https://github.com/o/r/issues/7" } : null;
  };
  const realPut = m.deps.store.put.bind(m.deps.store);
  m.deps.store.put = () => { throw new Error("crash"); };
  await assert.rejects(onLabelEvent(lab(), m.deps), /crash/);
  m.deps.store.put = realPut;
  assert.equal(await onLabelEvent(lab(), m.deps), "created");
  assert.equal(created.length, 1);
  assert.equal(m.deps.store.getByForge(3)?.github, 7);
});

test("syncComments skips comments we authored (reply marker)", async () => {
  const m = mk();
  await onLabelEvent(lab(), m.deps);
  let posted = "";
  m.deps.github.comment = async (_n, b) => { posted = b; };
  await replyToTwin(3, "Thanks, fixed.", m.deps);
  m.deps.github.listComments = async () => [{ id: 50, user: "bot", body: posted }];
  m.forgeComments.length = 0;
  assert.equal(await syncComments(m.deps), 0);
  assert.equal(m.forgeComments.length, 0);
  assert.ok(m.deps.store.getByForge(3)!.seenComments.github.includes(50));
});
