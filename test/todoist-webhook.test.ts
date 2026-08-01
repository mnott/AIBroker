/**
 * test/todoist-webhook.test.ts — the Todoist inbound channel.
 *
 * This endpoint turns a task filed from a phone into an instruction a session
 * executes with the user's full rights, so `route()` is not a convenience — it
 * is the security boundary. Todoist's payload documents that `initiator` may be
 * "a collaborator from a shared project", which is exactly the exposure these
 * tests pin down.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  verifySignature,
  route,
  eventKey,
  AGENT_MARK,
  type TodoistEvent,
  type WebhookConfig,
} from "../src/daemon/todoist-webhook.js";

const SECRET = "s3cret";
const INGRESS = "proj-ingress";
const INBOX = "proj-inbox";
const OWNED = "proj-whazaa";

const cfg: WebhookConfig = {
  secret: SECRET, port: 8766, bind: "127.0.0.1", path: "/todoist",
  ingressProjectIds: new Set([INGRESS, INBOX, OWNED]),
  projectOwners: new Map([[OWNED, "whazaa"]]),
  defaultOwner: "broker",
};

const task = (over: Record<string, unknown> = {}): TodoistEvent => ({
  event_name: "item:added",
  triggered_at: "2026-08-01T16:00:00.0Z",
  initiator: { email: "owner@example.com", id: "1" },
  event_data: {
    id: "task-1",
    content: "Run the job sweep",
    description: "",
    project_id: INGRESS,
    labels: ["pai:whazaa"],
    ...over,
  },
});

// ── signature ───────────────────────────────────────────────────────────────

test("a correctly signed body verifies", () => {
  const raw = Buffer.from(JSON.stringify(task()));
  const sig = createHmac("sha256", SECRET).update(raw).digest("base64");
  assert.equal(verifySignature(raw, sig, SECRET), true);
});

test("a tampered body does not verify", () => {
  const raw = Buffer.from(JSON.stringify(task()));
  const sig = createHmac("sha256", SECRET).update(raw).digest("base64");
  const tampered = Buffer.from(JSON.stringify(task({ content: "rm -rf /" })));
  assert.equal(verifySignature(tampered, sig, SECRET), false);
});

test("a missing signature is rejected", () => {
  assert.equal(verifySignature(Buffer.from("{}"), undefined, SECRET), false);
});

test("a signature from the wrong secret is rejected", () => {
  const raw = Buffer.from(JSON.stringify(task()));
  const sig = createHmac("sha256", "wrong").update(raw).digest("base64");
  assert.equal(verifySignature(raw, sig, SECRET), false);
});

test("garbage in the signature header does not throw", () => {
  assert.doesNotThrow(() => verifySignature(Buffer.from("{}"), "!!!not base64!!!", SECRET));
  assert.equal(verifySignature(Buffer.from("{}"), "!!!not base64!!!", SECRET), false);
});

// ── the boundary ────────────────────────────────────────────────────────────

test("a task in the ingress project with an owner label is acted on", () => {
  const d = route(task(), cfg);
  assert.equal(d.act, true);
  assert.equal(d.act && d.project, "whazaa");
  assert.equal(d.act && d.body, "Run the job sweep");
});

test("a task in ANY OTHER project is refused", () => {
  // The shared-project exposure: a collaborator filing into a project they
  // share with the user must not reach this machine.
  const d = route(task({ project_id: "some-shared-project" }), cfg);
  assert.equal(d.act, false);
  assert.match(d.act === false ? d.reason : "", /not an ingress project/);
});

test("a label cannot smuggle a task in from outside the allowlist", () => {
  // The boundary is the project, not the label. Otherwise anyone able to file
  // into a shared project could route work by adding a label.
  const d = route(task({ project_id: "some-shared-project", labels: ["pai:whazaa"] }), cfg);
  assert.equal(d.act, false);
});

test("a task filed into an owned project routes there without a label", () => {
  // "Put it in the Whazaa list" — the project IS the routing instruction.
  const d = route(task({ labels: [], project_id: OWNED }), cfg);
  assert.equal(d.act, true);
  assert.equal(d.act && d.project, "whazaa");
});

test("an Inbox task with no label goes to the default owner — the watch case", () => {
  // Captured from a watch there is no project and no label. This must work, or
  // the most common way of filing something is the one that fails.
  const d = route(task({ labels: [], project_id: INBOX }), cfg);
  assert.equal(d.act, true);
  assert.equal(d.act && d.project, "broker");
});

test("a label overrides the project it was filed in", () => {
  const d = route(task({ labels: ["pai:telex"], project_id: OWNED }), cfg);
  assert.equal(d.act && d.project, "telex");
});

test("with no default owner, an unroutable task is dropped rather than guessed", () => {
  const strict: WebhookConfig = { ...cfg, defaultOwner: undefined };
  const d = route(task({ labels: [], project_id: INBOX }), strict);
  assert.equal(d.act, false);
  assert.match(d.act === false ? d.reason : "", /no default owner/);
});

test("completing a task never starts work", () => {
  // Completion is the human saying "done". Acting on it would run the task
  // again at the moment it was declared finished.
  const e = { ...task(), event_name: "item:completed" };
  const d = route(e, cfg);
  assert.equal(d.act, false);
  assert.match(d.act === false ? d.reason : "", /no action taken/);
});

test("a fired reminder IS actionable — this is how scheduling works", () => {
  // Due dates do not push; reminders do. This event is the whole reason the
  // design needs no timer.
  const e = { ...task(), event_name: "reminder:fired" };
  const d = route(e, cfg);
  assert.equal(d.act, true);
});

test("unrelated event types are ignored", () => {
  for (const name of ["project:added", "label:deleted", "note:updated", "item:deleted"]) {
    const d = route({ ...task(), event_name: name }, cfg);
    assert.equal(d.act, false, `${name} must not be actionable`);
  }
});

// ── echo loops ──────────────────────────────────────────────────────────────

test("agent-authored content is ignored, so comments cannot loop", () => {
  // An agent writing back to Todoist fires an event; without this the reply
  // becomes an instruction to an agent, forever.
  const d = route(task({ content: `${AGENT_MARK} done: archived 40 mails` }), cfg);
  assert.equal(d.act, false);
  assert.match(d.act === false ? d.reason : "", /echo loop/);
});

test("the loop guard also covers the description", () => {
  const d = route(task({ description: `${AGENT_MARK} progress note` }), cfg);
  assert.equal(d.act, false);
});

test("initiator alone cannot break a loop, which is why marking is used", () => {
  // Agents act AS the user, so the initiator on an agent-written event is the
  // user. Documented here because it is the reason for the marker.
  const asUser = task({ content: `${AGENT_MARK} x` });
  assert.deepEqual(asUser.initiator, { email: "owner@example.com", id: "1" });
  assert.equal(route(asUser, cfg).act, false, "must be caught by the mark, not the initiator");
});

// ── content ─────────────────────────────────────────────────────────────────

test("the description is appended to the title as the body", () => {
  const d = route(task({ description: "Only the last 7 days." }), cfg);
  assert.equal(d.act && d.body, "Run the job sweep\n\nOnly the last 7 days.");
});

test("an empty task is not dispatched", () => {
  const d = route(task({ content: "   " }), cfg);
  assert.equal(d.act, false);
});

test("the owner label is case-insensitive on the prefix", () => {
  assert.equal(route(task({ labels: ["PAI:whazaa"] }), cfg).act, true);
});

// ── replay ──────────────────────────────────────────────────────────────────

test("the same delivery twice has the same key, a different one does not", () => {
  // Todoist retries. A retry must not run the work again.
  assert.equal(eventKey(task()), eventKey(task()));
  assert.notEqual(eventKey(task()), eventKey({ ...task(), triggered_at: "2026-08-01T16:00:01.0Z" }));
});

// ── configuration safety ────────────────────────────────────────────────────

test("an empty allowlist accepts NOTHING — it fails closed", () => {
  // The opposite of the earlier design, where an unset ingress meant "allow
  // everything". An empty allowlist must be the safest state, not the most
  // permissive, because that is what a misconfiguration produces.
  const empty: WebhookConfig = {
    secret: SECRET, port: 1, bind: "127.0.0.1", path: "/todoist",
    ingressProjectIds: new Set(), projectOwners: new Map(), defaultOwner: "broker",
  };
  assert.equal(route(task({ project_id: INBOX }), empty).act, false);
  assert.equal(route(task({ project_id: "anything" }), empty).act, false);
});
