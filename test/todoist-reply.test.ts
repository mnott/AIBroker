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
