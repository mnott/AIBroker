import "./home-guard.js";
/**
 * test/todoist-reply.test.ts — answering on the task.
 *
 * The reply path writes to Todoist with the account's own credentials, and
 * every comment it writes comes straight back at the receiver as a webhook.
 * These tests pin the two properties that keep that from becoming a loop: the
 * agent mark is applied here rather than trusted to callers, and route() drops
 * anything carrying it before it can be read as an instruction.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "aibroker-reply-"));
process.env.HOME = scratch;
mkdirSync(join(scratch, ".aibroker"), { recursive: true });

const { AGENT_MARK, route } = await import("../src/daemon/todoist-webhook.js");
const { replyToTask } = await import("../src/daemon/todoist-reply.js");
const { fetchCommentActivity } = await import("../src/daemon/todoist-inbox.js");
const { saveToken } = await import("../src/daemon/todoist-oauth.js");
import type { WebhookConfig, TodoistEvent } from "../src/daemon/todoist-webhook.js";

saveToken({ access_token: "tok", token_type: "Bearer", obtained_at: new Date().toISOString() });

function captureFetch(status = 200, body: unknown = { id: "c-1" }) {
  const seen: { url?: string; auth?: string; payload?: any } = {};
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.url = String(url);
    seen.auth = (init?.headers as Record<string, string>)?.authorization;
    seen.payload = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { impl, seen };
}

test("the agent mark is applied by the writer, not trusted to the caller", async () => {
  const { impl, seen } = captureFetch();
  await replyToTask("task-1", "Two open, both p2.", impl);
  assert.ok(seen.payload.content.startsWith(AGENT_MARK));
  assert.equal(seen.payload.task_id, "task-1");
  assert.equal(seen.url, "https://api.todoist.com/api/v1/comments");
  assert.equal(seen.auth, "Bearer tok");
});

// ── the request itself: same token, same API as the reader ─────────────────
//
// 2026-11-19 07:25–07:27: todoist_reply failed 3× with 401 / error_code 477 on
// one task while todoist_inbox "worked" minutes later. The hunt went to endpoint
// and token-source differences (REST v2 vs Sync v9, a project-scoped or shared
// token, a stale base URL). There are none: both paths take the account's OAuth
// token from getAccessToken() and hit api.todoist.com/api/v1. This pins that so
// the next 477 is read as what it is — a dead grant — not as an endpoint bug.

test("the reply request carries the stored OAuth token to the unified v1 API", async () => {
  // The auth header must come from the SAME file the reader uses: a token
  // written here and read there is the only credential either path may present.
  const { loadToken } = await import("../src/daemon/todoist-oauth.js");
  saveToken({ access_token: "acct-token", token_type: "Bearer", obtained_at: new Date().toISOString() });
  const { impl, seen } = captureFetch();
  await replyToTask("task-7", "answer", impl);
  assert.equal(seen.url, "https://api.todoist.com/api/v1/comments");
  assert.equal(seen.auth, `Bearer ${loadToken()!.access_token}`);
  assert.deepEqual(seen.payload, { task_id: "task-7", content: `${AGENT_MARK} answer` });
});

test("a 401 on the comment is a dead grant, not an endpoint problem", async () => {
  // With no refresh path there is nothing to retry; the error must name the
  // token and the remedy rather than leave "comment failed with 401" to be
  // read as an endpoint or credential mismatch.
  process.env.TODOIST_CLIENT_ID = "";
  process.env.TODOIST_CLIENT_SECRET = "";
  saveToken({ access_token: "revoked", token_type: "Bearer", obtained_at: new Date().toISOString() });
  const impl = (async () =>
    new Response(JSON.stringify({ error_code: 477 }), { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(
    () => replyToTask("task-8", "hi", impl),
    /invalid or expired .* cannot be refreshed \(no refresh token on file\).*aibroker todoist auth/,
  );
});

// ── the reader must fail like the writer ────────────────────────────────────
//
// The other half of the 2026-11-19 incident: `todoist_inbox` "worked" at 07:29
// while the reply path 401'd, because fetchCommentActivity swallowed the dead
// token's 401 into an empty list — a revoked grant reading as "no new
// comments". Both paths take the same stored OAuth token to the same unified
// v1 host; the asymmetry was only in error handling.

test("the activity read uses the same unified v1 host and stored token", async () => {
  let url = "", auth = "";
  const impl = (async (u: string | URL | Request, init?: RequestInit) => {
    url = String(u);
    auth = (init?.headers as Record<string, string>)?.authorization ?? "";
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  await fetchCommentActivity(impl);
  assert.match(url, /^https:\/\/api\.todoist\.com\/api\/v1\/activities\?/);
  assert.equal(auth, "Bearer revoked"); // the token on file — same source as the reply's
});

test("a 401 from the activity read surfaces — it is not an empty inbox", async () => {
  // Same single-flight refresh as every path: getAccessToken() tries to renew,
  // the revoked grant refuses (no credentials on file here), and what reaches
  // the API is still a 401 — which must now surface, not become [].
  process.env.TODOIST_CLIENT_ID = "";
  process.env.TODOIST_CLIENT_SECRET = "";
  const impl = (async () =>
    new Response(JSON.stringify({ error_code: 477 }), { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(
    () => fetchCommentActivity(impl),
    /401.*invalid or expired.*aibroker todoist auth/,
  );
});

test("a transient failure on the activity read still returns an empty list", async () => {
  // The digest must survive a blip; only the auth failure is loud.
  const impl = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
  assert.deepEqual(await fetchCommentActivity(impl), []);
});

test("a 401 with a refresh token is refreshed and retried once", async () => {
  process.env.TODOIST_CLIENT_ID = "cid";
  process.env.TODOIST_CLIENT_SECRET = "secret";
  saveToken({
    access_token: "stale", token_type: "Bearer", obtained_at: new Date().toISOString(),
    refresh_token: "r1", expires_at: new Date(Date.now() + 3600_000).toISOString(),
  });
  let calls = 0;
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls++;
    if (String(url).includes("/oauth/access_token")) {
      return new Response(JSON.stringify({
        access_token: "fresh", token_type: "Bearer", expires_in: 3600, refresh_token: "r2",
      }), { status: 200 });
    }
    const auth = (init?.headers as Record<string, string>)?.authorization ?? "";
    if (auth.includes("stale")) {
      return new Response(JSON.stringify({ error_code: 477 }), { status: 401 });
    }
    return new Response(JSON.stringify({ id: "c-9" }), { status: 200 });
  }) as unknown as typeof fetch;

  const r = await replyToTask("task-9", "late answer", impl);
  assert.equal(r.commentId, "c-9");
  // stale comment, refresh, retried comment — and no third attempt.
  assert.equal(calls, 3);
});

test("an already-marked reply is not marked twice", async () => {
  const { impl, seen } = captureFetch();
  await replyToTask("task-1", `${AGENT_MARK} already marked`, impl);
  assert.equal(seen.payload.content.startsWith(`${AGENT_MARK} ${AGENT_MARK}`), false);
});

test("a refused write surfaces the status instead of reporting success", async () => {
  const { impl } = captureFetch(403, { error: "forbidden" });
  await assert.rejects(() => replyToTask("task-1", "hi", impl), /403/);
});

// ── the loop that must not happen ───────────────────────────────────────────

test("our own comment cannot come back as an instruction", () => {
  const cfg: WebhookConfig = {
    secret: "s", port: 1, bind: "127.0.0.1", path: "/todoist", oauthPath: "/oauth",
    ingressProjectIds: new Set(["p"]), projectOwners: new Map(), defaultOwner: "home",
  };
  // What Todoist sends back after replyToTask: a note whose content is ours.
  const echo: TodoistEvent = {
    event_name: "note:added",
    event_data: { id: "n-1", content: `${AGENT_MARK} Two open, both p2.`, project_id: "p", labels: [] },
  };
  const d = route(echo, cfg, ["home"]);
  assert.equal(d.act, false);
  assert.match((d as { reason: string }).reason, /echo loop/);
});

test("a human comment on the same task is not suppressed by the guard", () => {
  const cfg: WebhookConfig = {
    secret: "s", port: 1, bind: "127.0.0.1", path: "/todoist", oauthPath: "/oauth",
    ingressProjectIds: new Set(["p"]), projectOwners: new Map(), defaultOwner: "home",
  };
  const human: TodoistEvent = {
    event_name: "note:added",
    event_data: { id: "n-2", content: "and what about the other one?", project_id: "p", labels: [] },
  };
  // Enriched with its parent's project and labels, a human comment routes like
  // any other work order — which is what makes a task a conversation.
  const d = route(human, cfg, ["home"]);
  assert.equal(d.act, true);
  if (!d.act) return;
  assert.equal(d.project, "home");
  assert.equal(d.body, "and what about the other one?");
});

// ── comments as instructions ────────────────────────────────────────────────

test("a comment addressed by its first word routes like any other task", () => {
  const cfg: WebhookConfig = {
    secret: "s", port: 1, bind: "127.0.0.1", path: "/todoist", oauthPath: "/oauth",
    ingressProjectIds: new Set(["p"]), projectOwners: new Map(), defaultOwner: "broker",
  };
  const c: TodoistEvent = {
    event_name: "note:added",
    event_data: {
      id: "task-9", content: "pai check the calendar again",
      project_id: "p", labels: [], description: '(comment on "send me a mail")',
    },
  };
  const d = route(c, cfg, ["pai", "broker"]);
  assert.equal(d.act && d.project, "pai");
  assert.equal(d.act && d.rule, "address");
  // The parent's title rides along as context, so the reply makes sense.
  assert.match(d.act ? d.body : "", /check the calendar again[\s\S]*comment on "send me a mail"/);
});

test("the boundary still applies to a comment — via its parent's project", () => {
  const cfg: WebhookConfig = {
    secret: "s", port: 1, bind: "127.0.0.1", path: "/todoist", oauthPath: "/oauth",
    ingressProjectIds: new Set(["allowed"]), projectOwners: new Map(), defaultOwner: "broker",
  };
  const c: TodoistEvent = {
    event_name: "note:added",
    event_data: { id: "t", content: "do something", project_id: "shared-with-a-colleague", labels: [] },
  };
  const d = route(c, cfg, ["broker"]);
  assert.equal(d.act, false);
  assert.match((d as { reason: string }).reason, /not an ingress project/);
});

test("the parent lookup asks for the task the comment hangs off", async () => {
  const { fetchParentTask } = await import("../src/daemon/todoist-reply.js");
  let asked = "";
  const impl = (async (url: string | URL | Request) => {
    asked = String(url);
    return new Response(JSON.stringify({
      content: "send me a mail", project_id: "p-1", labels: ["paicloud"],
    }), { status: 200 });
  }) as unknown as typeof fetch;

  const parent = await fetchParentTask("task-9", impl);
  assert.match(asked, /\/api\/v1\/tasks\/task-9$/);
  assert.equal(parent.projectId, "p-1");
  assert.deepEqual(parent.labels, ["paicloud"]);
});

// ── duplicate titles ────────────────────────────────────────────────────────
//
// Two open tasks with the same title are indistinguishable in a list. A reply
// posted on one is, to whoever is watching the other, indistinguishable from
// being ignored — which cost two rounds today while comment routing worked
// perfectly the whole time.

test("a unique title counts once", async () => {
  const { countTasksWithTitle } = await import("../src/daemon/todoist-reply.js");
  const impl = (async () => new Response(JSON.stringify({
    results: [{ content: "send me a mail" }, { content: "something else" }],
  }), { status: 200 })) as unknown as typeof fetch;
  assert.equal(await countTasksWithTitle("p", "send me a mail", impl), 1);
});

test("siblings are counted, ignoring case and stray whitespace", async () => {
  // A human scanning a list does not see the difference either.
  const { countTasksWithTitle } = await import("../src/daemon/todoist-reply.js");
  const impl = (async () => new Response(JSON.stringify({
    results: [{ content: "Send me a  mail" }, { content: "send me a mail " }, { content: "other" }],
  }), { status: 200 })) as unknown as typeof fetch;
  assert.equal(await countTasksWithTitle("p", "send me a mail", impl), 2);
});

test("a bare array response is accepted too", async () => {
  const { countTasksWithTitle } = await import("../src/daemon/todoist-reply.js");
  const impl = (async () => new Response(JSON.stringify([{ content: "x" }, { content: "x" }]), { status: 200 })) as unknown as typeof fetch;
  assert.equal(await countTasksWithTitle("p", "x", impl), 2);
});

test("a failed lookup reports zero, never a phantom duplicate", async () => {
  // Warning about a twin that may not exist is worse than not warning.
  const { countTasksWithTitle } = await import("../src/daemon/todoist-reply.js");
  const impl = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
  assert.equal(await countTasksWithTitle("p", "x", impl), 0);
});

// ── writing into your own inbox ─────────────────────────────────────────────
//
// A session filing a task into an ingress project is writing to its own inbox:
// item:added fires, routing dispatches it, and the session receives its own
// note as a work order. On 2026-08-01 a session probing due-date parsing was
// handed twelve of its own test tasks in four minutes.

test("a task created by a session is marked, so it cannot dispatch back", async () => {
  const { createTask } = await import("../src/daemon/todoist-reply.js");
  const { impl, seen } = captureFetch(200, { id: "t-1" });
  await createTask("ZZ due probe 2026-08-02", { projectId: "p-1", dueString: "tomorrow" }, impl);
  assert.ok(seen.payload.content.startsWith(AGENT_MARK));
  assert.equal(seen.payload.project_id, "p-1");
  assert.equal(seen.payload.due_string, "tomorrow");
  assert.equal(seen.url, "https://api.todoist.com/api/v1/tasks");
});

test("a marked task is dropped by routing, closing the loop", () => {
  const cfg: WebhookConfig = {
    secret: "s", port: 1, bind: "127.0.0.1", path: "/todoist", oauthPath: "/oauth",
    ingressProjectIds: new Set(["p-1"]), projectOwners: new Map([["p-1", "task-bus"]]),
    defaultOwner: "broker",
  };
  const echo: TodoistEvent = {
    event_name: "item:added",
    event_data: { id: "t-1", content: `${AGENT_MARK} ZZ due probe`, project_id: "p-1", labels: [] },
  };
  const d = route(echo, cfg, ["task-bus"]);
  assert.equal(d.act, false);
  assert.match((d as { reason: string }).reason, /echo loop/);
});

test("a refused create surfaces the status rather than reporting a task id", async () => {
  const { createTask } = await import("../src/daemon/todoist-reply.js");
  const { impl } = captureFetch(400, { error: "bad" });
  await assert.rejects(() => createTask("x", {}, impl), /400/);
});

// ── filing work for LATER is the point ──────────────────────────────────────

test("an agent-authored task still fires its reminder", () => {
  // The echo guard must not kill scheduled work. A click-to-run task with a
  // recurrence — "run the sweep at 08:00" — is agent-authored on purpose and
  // has to fire when its time comes. Suppressing it would have silently broken
  // the job-sweep trigger the moment it was marked.
  const cfg: WebhookConfig = {
    secret: "s", port: 1, bind: "127.0.0.1", path: "/todoist", oauthPath: "/oauth",
    ingressProjectIds: new Set(["p-1"]), projectOwners: new Map([["p-1", "task-bus"]]),
    defaultOwner: "broker",
  };
  const fired: TodoistEvent = {
    event_name: "reminder:fired",
    event_data: { id: "t-9", content: `${AGENT_MARK} Job sweep — run it and mail me the list`, project_id: "p-1", labels: [] },
  };
  const d = route(fired, cfg, ["task-bus"]);
  assert.equal(d.act, true, "a scheduled trigger must survive the echo guard");
  assert.equal(d.act && d.project, "task-bus");
});

test("the same task's creation is still suppressed", () => {
  // Only the write that bounces back instantly is dropped.
  const cfg: WebhookConfig = {
    secret: "s", port: 1, bind: "127.0.0.1", path: "/todoist", oauthPath: "/oauth",
    ingressProjectIds: new Set(["p-1"]), projectOwners: new Map([["p-1", "task-bus"]]),
    defaultOwner: "broker",
  };
  const created: TodoistEvent = {
    event_name: "item:added",
    event_data: { id: "t-9", content: `${AGENT_MARK} Job sweep — run it and mail me the list`, project_id: "p-1", labels: [] },
  };
  assert.equal(route(created, cfg, ["task-bus"]).act, false);
});

// ── a claim that flaps ──────────────────────────────────────────────────────
//
// Observed twice on 2026-08-01: the claim write failed with 401 and a
// retry_after of a few seconds, the dispatch proceeded unclaimed, and PAI's
// poller then read the same tick as a fresh request. The failure was in a log
// file and nowhere else.

test("a 401 is refreshed and retried, never re-presented as-is", async () => {
  // Todoist is explicit: 401 with error_code 477 means the token is invalid or
  // expired, and "do not wait and retry the same invalid or expired token".
  // The first version of this slept for retry_after and presented the same dead
  // token again — it could only ever fail twice and call it a flap.
  process.env.TODOIST_CLIENT_ID = "cid";
  process.env.TODOIST_CLIENT_SECRET = "secret";
  saveToken({
    // Deliberately NOT expired: a 401 means invalid NOW, and a token can be
    // invalid long before its stated expiry.
    access_token: "stale", token_type: "Bearer", obtained_at: new Date().toISOString(),
    refresh_token: "r1", expires_at: new Date(Date.now() + 3600_000).toISOString(),
  });
  let calls = 0;
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls++;
    if (String(url).includes("/oauth/access_token")) {
      return new Response(JSON.stringify({
        access_token: "fresh", token_type: "Bearer", expires_in: 3600, refresh_token: "r2",
      }), { status: 200 });
    }
    const auth = (init?.headers as Record<string, string>)?.authorization ?? "";
    if (auth.includes("stale")) {
      return new Response(JSON.stringify({ error_code: 477, error_extra: { retry_after: 3 } }), { status: 401 });
    }
    if (init?.method === "POST") return new Response("{}", { status: 200 });
    return new Response(JSON.stringify({ labels: [] }), { status: 200 });
  }) as unknown as typeof fetch;

  const { setTaskLabel } = await import("../src/daemon/todoist-reply.js");
  const labels = await setTaskLabel("t-401", "pai-running", true, impl);
  assert.deepEqual(labels, ["pai-running"]);
  assert.ok(calls >= 3, "the stale lookup, a refresh, then the retry");
});

test("a 401 with no refresh token says re-authorise rather than retrying", async () => {
  // Legacy apps have no refresh path, so nothing helps and the error should say
  // so rather than leave it to be inferred from a second identical failure.
  saveToken({ access_token: "dead", token_type: "Bearer", obtained_at: new Date().toISOString() });
  let calls = 0;
  const impl = (async () => {
    calls++;
    return new Response(JSON.stringify({ error_code: 477 }), { status: 401 });
  }) as unknown as typeof fetch;

  const { setTaskLabel } = await import("../src/daemon/todoist-reply.js");
  await assert.rejects(
    () => setTaskLabel("t-dead", "pai-running", true, impl),
    /cannot be refreshed \(no refresh token on file\)/,
  );
  assert.equal(calls, 1, "no retry of a token that cannot be renewed");
});

test("a failure with no retry_after is not retried", async () => {
  // A hard refusal is not a flap; retrying it just doubles the load that may
  // have caused it.
  let calls = 0;
  const impl = (async () => { calls++; return new Response("nope", { status: 403 }); }) as unknown as typeof fetch;
  const { setTaskLabel } = await import("../src/daemon/todoist-reply.js");
  await assert.rejects(() => setTaskLabel("t-hard", "pai-running", true, impl), /403/);
  assert.equal(calls, 1);
});

test("a mirrored reply is filed once: the mirror entry gets no duplicate comment", async () => {
  process.env.TODOIST_MIRROR_PROJECT = "mirror-p";
  const { mirrorComment } = await import("../src/daemon/todoist-mirror.js");
  const calls: { method: string; url: string }[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ method: init?.method ?? "GET", url: u });
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (u.includes("/sections")) return json({ results: [{ id: "s1", name: "Unfiled" }] });
    if (u.includes("/tasks/orig")) return json({ id: "orig", content: "Origin", project_id: "p1", url: "https://app.todoist.com/app/task/orig" });
    if (u.includes("/projects")) return json({ results: [] });
    return json({ id: "new-1" });
  }) as unknown as typeof fetch;
  await mirrorComment({ taskId: "orig", commentId: "c1", text: "x".repeat(400) }, impl);
  delete process.env.TODOIST_MIRROR_PROJECT;
  assert.equal(calls.filter((c) => c.method === "POST" && c.url.includes("/comments")).length, 0);
});
