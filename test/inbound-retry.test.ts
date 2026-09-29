import "./home-guard.js";
/**
 * test/inbound-retry.test.ts — an owner with no live pane must not lose the event.
 *
 * Pinned on 2026-09-27: deliverBatch(), finding no pane matching route.owner
 * (iTerm2 restarting, tmux briefly unreachable), returned ok:false and the
 * batch was discarded — never deposited, never retried. With a coalesce route
 * the webhook had already been acked, so the only trace was a log line saying
 * "held for grouping" and the audit trail never recorded the loss.
 *
 * The fix keeps the batch in memory and retries delivery once the owner's
 * session reappears, and audits every no-session outcome so the trail no
 * longer goes quiet.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const route = () =>
  ({ name: "apps-caseleaf", owner: "CaseLeaf", mode: "message", createdAt: "" }) as any;

test("an owner with no live pane is retried, not dropped", async (t) => {
  let live = false;
  let deposited: { id: string; from: string; body: string } | undefined;

  t.mock.module("../src/core/session-match.js", {
    namedExports: {
      matchSession: (_names: string[], candidates: { id: string; name: string }[]) =>
        live ? { session: candidates[0] } : undefined,
    },
  });
  t.mock.module("../src/transport/sync-facade.js", {
    namedExports: {
      snapshotAllSessions: () => (live ? [{ id: "pane-1", name: "CaseLeaf", aibrokerId: undefined }] : []),
      isClaudeSession: () => true,
    },
  });
  t.mock.module("../src/core/persistence.js", {
    namedExports: {
      getAllPersistentSessionNames: () => [],
      lookupPersistentName: () => undefined,
    },
  });
  t.mock.module("../src/core/state.js", {
    namedExports: {
      depositToSessionMailbox: (id: string, from: string, body: string) => { deposited = { id, from, body }; },
    },
  });
  t.mock.module("../src/daemon/dispatch.js", {
    namedExports: { submitAndConfirm: async () => "ok" },
  });

  const { deliverInbound, __retryPendingNow } = await import("../src/daemon/inbound.js");
  const { readAudit } = await import("../src/daemon/audit.js");

  const before = readAudit({ action: "inbound" }).length;

  // No pane for CaseLeaf: must not report success, and must not vanish.
  const r1 = await deliverInbound(route(), { text: "hello" });
  assert.equal(r1.ok, false, "no live session must not be reported as delivered");
  assert.match(r1.detail, /no live session matches owner/);

  const afterFirst = readAudit({ action: "inbound" });
  assert.equal(afterFirst.length, before + 1, "the no-session outcome must be audited, not silent");
  const entry = afterFirst[afterFirst.length - 1];
  assert.equal(entry.outcome, "retrying");
  assert.equal(entry.target, "session:CaseLeaf");

  // Retrying while still absent changes nothing yet.
  await __retryPendingNow();
  assert.equal(deposited, undefined, "must not deliver while the session is still absent");

  // The session comes back.
  live = true;
  await __retryPendingNow();

  assert.ok(deposited, "the held batch must be delivered once the owner's session is back");
  assert.equal(deposited?.id, "pane-1");
  assert.match(deposited?.body ?? "", /hello/);

  const afterRetry = readAudit({ action: "inbound" });
  const delivered = afterRetry[afterRetry.length - 1];
  assert.equal(delivered.outcome, "delivered");
  assert.equal(delivered.target, "session:CaseLeaf");
});

test("a non-ok ack is not reported as delivered", async (t) => {
  t.mock.module("../src/core/session-match.js", {
    namedExports: {
      matchSession: (_names: string[], candidates: { id: string; name: string }[]) => ({ session: candidates[0] }),
    },
  });
  t.mock.module("../src/transport/sync-facade.js", {
    namedExports: {
      snapshotAllSessions: () => [{ id: "pane-1", name: "CaseLeaf", aibrokerId: undefined }],
      isClaudeSession: () => true,
    },
  });
  t.mock.module("../src/core/persistence.js", {
    namedExports: {
      getAllPersistentSessionNames: () => [],
      lookupPersistentName: () => undefined,
    },
  });
  t.mock.module("../src/core/state.js", {
    namedExports: { depositToSessionMailbox: () => {} },
  });
  t.mock.module("../src/daemon/dispatch.js", {
    namedExports: { submitAndConfirm: async () => "no-ack" },
  });

  const { deliverInbound } = await import("../src/daemon/inbound.js");
  const r = await deliverInbound(route(), { text: "hello" });
  assert.doesNotMatch(r.detail, /delivered to/, "a non-ok ack must not be reported as delivered");
  assert.match(r.detail, /no-ack/, "the ack value must be visible in the detail");
});

test("a retry that throws is not lost — the queue keeps going", async (t) => {
  let live = false;
  let attempts = 0;
  let deposited: { id: string; body: string } | undefined;

  t.mock.module("../src/core/session-match.js", {
    namedExports: {
      matchSession: (_names: string[], candidates: { id: string; name: string }[]) => {
        if (!live) return undefined;
        attempts++;
        if (attempts === 1) throw new Error("boom");
        return { session: candidates[0] };
      },
    },
  });
  t.mock.module("../src/transport/sync-facade.js", {
    namedExports: {
      snapshotAllSessions: () => (live ? [{ id: "pane-1", name: "CaseLeaf", aibrokerId: undefined }] : []),
      isClaudeSession: () => true,
    },
  });
  t.mock.module("../src/core/persistence.js", {
    namedExports: {
      getAllPersistentSessionNames: () => [],
      lookupPersistentName: () => undefined,
    },
  });
  t.mock.module("../src/core/state.js", {
    namedExports: {
      depositToSessionMailbox: (id: string, _from: string, body: string) => { deposited = { id, body }; },
    },
  });
  t.mock.module("../src/daemon/dispatch.js", {
    namedExports: { submitAndConfirm: async () => "ok" },
  });

  const { deliverInbound, __retryPendingNow } = await import("../src/daemon/inbound.js");

  // No pane yet: queued for retry.
  await deliverInbound(route(), { text: "hello" });

  // Session appears, but the first retry attempt throws.
  live = true;
  await __retryPendingNow();
  assert.equal(deposited, undefined, "a throwing attempt must not be treated as delivered");

  // The queue must still be alive for the next tick.
  await __retryPendingNow();
  assert.ok(deposited, "a throw on one attempt must not strand the rest of the queue");
});
