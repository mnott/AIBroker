import "./home-guard.js";
/**
 * test/todoist-pending.test.ts — a transient resolve failure must not drop the event.
 *
 * Pins the fault behind audit ab-mudmf06z: a `reminder:fired` webhook whose
 * parent-task lookup failed with "fetch failed" (the daemon's event loop was
 * blocked at the time, fixed in 0.58.1) was dropped outright. These tests
 * cover the three outcomes that replace that drop: retry-then-succeed,
 * persist-then-recover-after-restart, and a genuine 404 still dropping.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "aibroker-pending-"));
process.env.HOME = scratch;
mkdirSync(join(scratch, ".aibroker"), { recursive: true });

const { saveToken } = await import("../src/daemon/todoist-oauth.js");
saveToken({ access_token: "tok", token_type: "Bearer", obtained_at: new Date().toISOString() });

const {
  resolveParentWithRetry, sweepPendingEvents, isTransientTodoistError, eventKey,
  isTrigger, route,
} = await import("../src/daemon/todoist-webhook.js");
const { queuePendingEvent, listPendingEvents } = await import("../src/daemon/todoist-pending.js");
const { listClaims } = await import("../src/daemon/todoist-claims.js");
import type { WebhookConfig, TodoistEvent, WebhookDeps } from "../src/daemon/todoist-webhook.js";

const cfg: WebhookConfig = {
  secret: "s3cret", port: 8766, bind: "127.0.0.1", path: "/todoist",
  ingressProjectIds: new Set(["proj-ingress"]),
  projectOwners: new Map(),
  defaultOwner: "broker",
};

const reminder = (id: string): TodoistEvent => ({
  event_name: "reminder:fired",
  triggered_at: "2026-09-23T04:46:32.0Z",
  initiator: { email: "owner@example.com", id: "1" },
  event_data: { id, item_id: "task-1" },
});

function taskResponse(status: number, body: unknown = { content: "Run the sweep", project_id: "proj-ingress", labels: [] }) {
  return new Response(JSON.stringify(body), { status });
}

const noSleep = async () => {};

// ── classifier ──────────────────────────────────────────────────────────────

test("a network failure with no HTTP status is transient", () => {
  assert.equal(isTransientTodoistError(new TypeError("fetch failed")), true);
});

test("429 and 5xx are transient", () => {
  assert.equal(isTransientTodoistError(new Error("task lookup failed with 429: too many requests")), true);
  assert.equal(isTransientTodoistError(new Error("task lookup failed with 503: down")), true);
});

test("404 and 401 are permanent", () => {
  assert.equal(isTransientTodoistError(new Error("task lookup failed with 404: not found")), false);
  assert.equal(isTransientTodoistError(new Error("task lookup failed with 401: unauthorized")), false);
});

// ── transient failure then success: delivered exactly once ──────────────────

test("a transient failure that later succeeds resolves and delivers exactly once", async () => {
  let calls = 0;
  const flaky = (async () => {
    calls++;
    if (calls < 3) throw new TypeError("fetch failed");
    return taskResponse(200);
  }) as unknown as typeof fetch;

  const event = reminder("rem-flaky");
  const result = await resolveParentWithRetry(event, "reminder", "task-1", [1, 1, 1], noSleep, flaky);

  assert.equal(result.ok, true);
  assert.equal(calls, 3, "must not keep retrying once it succeeds");
  assert.equal(event.event_data?.project_id, "proj-ingress");
});

// ── all inline attempts fail: persisted, then delivered after a simulated restart ──

test("exhausting inline retries queues the event, and the next sweep delivers it once", async () => {
  const alwaysFails = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;

  const event = reminder("rem-outage");
  const key = eventKey(event);
  const inlineResult = await resolveParentWithRetry(event, "reminder", "task-1", [1, 1], noSleep, alwaysFails);
  assert.equal(inlineResult.ok, false);
  assert.equal(inlineResult.transient, true);

  queuePendingEvent({ key, event, kind: "reminder", parentId: "task-1", lastError: inlineResult.reason });
  assert.equal(listPendingEvents().some((p) => p.key === key), true, "must survive to be picked up on the next tick / restart");

  // "Restart": a fresh process would call sweepPendingEvents on the same disk
  // file with no in-memory state carried over — simulated here by reading the
  // queue fresh and pointing the network at a recovered backend.
  let delivered = 0;
  const recovered = (async () => taskResponse(200)) as unknown as typeof fetch;
  const deps: WebhookDeps = {
    deliver: async (project, body) => { delivered++; return { outcome: "delivered", session: project }; },
  };
  await sweepPendingEvents(cfg, deps, recovered);

  assert.equal(delivered, 1, "the reminder must reach dispatch exactly once");
  assert.equal(listPendingEvents().some((p) => p.key === key), false, "delivered events must not stay queued");

  // A second sweep must not redeliver — the event is gone from the queue.
  await sweepPendingEvents(cfg, deps, recovered);
  assert.equal(delivered, 1, "a later sweep must not deliver the same event twice");
});

// ── permanent failure: dropped, not queued ───────────────────────────────────

test("a 404 is dropped immediately, not queued for retry", async () => {
  const gone = (async () => taskResponse(404, "not found")) as unknown as typeof fetch;
  const event = reminder("rem-gone");
  const key = eventKey(event);

  const result = await resolveParentWithRetry(event, "reminder", "task-1", [1, 1, 1], noSleep, gone);

  assert.equal(result.ok, false);
  assert.equal(result.transient, false);
  assert.equal(listPendingEvents().some((p) => p.key === key), false, "a permanent failure must never reach the disk queue");
});

// ── a reminder on a recurring trigger must claim before dispatching ─────────
//
// Real fault, 24./25.09 ~06:57 ("Job sweep Gina", task bus 6hccprFMww4pX3M9):
// a reminder:fired dispatch carried no pai-running claim, so when the session
// finished with `pai task done`, the resulting item:completed looked exactly
// like a human tick — recurring, addressed, unclaimed — and route() dispatched
// the same sweep a second time.

/** Fresh each call — a Response body can only be read once. */
const triggerParent = () => taskResponse(200, {
  content: "Job sweep", project_id: "proj-ingress", labels: ["pai:broker"],
  due: { date: "2026-09-25", is_recurring: true },
});

test("a resolved reminder keeps the task's due, so isTrigger recognises it", async () => {
  const event = reminder("rem-trigger");
  const result = await resolveParentWithRetry(
    event, "reminder", "task-1", [1], noSleep, (async () => triggerParent()) as unknown as typeof fetch,
  );

  assert.equal(result.ok, true);
  assert.equal(isTrigger(event.event_data ?? {}), true, "without the merged due, the dispatch cannot be claimed");
});

test("a reminder-dispatched trigger records a claim — and the run's own completion is then suppressed", async () => {
  // setTaskLabel runs on the global fetch (this path has no injection point):
  // a GET for the task's labels, then the POST that adds pai-running.
  const realFetch = globalThis.fetch;
  const labelWrites: string[] = [];
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    if (String(init?.method ?? "GET").toUpperCase() === "POST") {
      labelWrites.push(String(init?.body ?? ""));
      return new Response("{}", { status: 200 });
    }
    return new Response(JSON.stringify({ labels: [] }), { status: 200 });
  }) as typeof fetch;

  try {
    const event = reminder("rem-claim");
    queuePendingEvent({ key: eventKey(event), event, kind: "reminder", parentId: "task-1", lastError: "queued by test" });

    const bodies: string[] = [];
    const deps: WebhookDeps = {
      deliver: async (_project, body) => { bodies.push(body); return { outcome: "delivered", session: "broker" }; },
    };
    await sweepPendingEvents(cfg, deps, (async () => triggerParent()) as unknown as typeof fetch);

    assert.equal(bodies.length, 1, "dispatched exactly once");
    assert.match(bodies[0] ?? "", /\[todoist:task-1 in:proj-ingress\]/, "the trailer names the task — what the redrive freshness gate keys on");
    assert.deepEqual(labelWrites, [JSON.stringify({ labels: ["pai-running"] })], "pai-running goes on the task BEFORE the dispatch");
    const claim = listClaims().find((c) => c.taskId === "task-1");
    assert.ok(claim, "the claim state route() keys on must be recorded");
    assert.equal(claim?.nextDue, "2026-09-25", "recorded with the task's current due");

    // The run's own `pai task done` completion now carries pai-running, and
    // route() must ignore it — the human-tick signature is broken.
    const completion: TodoistEvent = {
      event_name: "item:completed",
      triggered_at: "2026-09-25T07:07:00.0Z",
      initiator: { email: "owner@example.com", id: "1" },
      event_data: {
        id: "task-1", content: "Job sweep", project_id: "proj-ingress",
        labels: ["pai:broker", "pai-running"], due: { is_recurring: true },
      },
    };
    const d = route(completion, cfg, ["broker"]);
    assert.equal(d.act, false, "the run's own completion must not re-dispatch the sweep");
    assert.match((d as { reason: string }).reason, /already in flight/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
