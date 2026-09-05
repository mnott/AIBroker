/**
 * test/a2a-schema.test.ts — the vendored-subset validator, checked against
 * a hand-built valid AgentCard/Task and against shapes known to be wrong.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAgentCard, validateTask, validateMessage } from "../src/a2a/schema/validate.js";

function validCard() {
  return {
    protocolVersion: "0.3.0",
    name: "aibroker",
    description: "a hub",
    url: "https://example.org/a2a",
    preferredTransport: "JSONRPC",
    version: "1.0.0",
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [{ id: "home", name: "home", description: "the home session", tags: ["aibroker"] }],
  };
}

test("card-validates-against-vendored-schema+ a well-formed card passes", () => {
  const r = validateAgentCard(validCard());
  assert.equal(r.ok, true, r.errors.join("; "));
});

test("a card missing required fields fails, naming each field", () => {
  const r = validateAgentCard({ name: "aibroker" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("protocolVersion")));
  assert.ok(r.errors.some((e) => e.includes("skills")));
});

test("a skill missing tags fails", () => {
  const card = validCard();
  // @ts-expect-error — deliberately malformed for the test
  delete card.skills[0].tags;
  const r = validateAgentCard(card);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("tags")));
});

test("task-validates-against-vendored-schema+ a well-formed task passes", () => {
  const task = {
    kind: "task", id: "t1", contextId: "c1",
    status: { state: "working", timestamp: new Date().toISOString() },
    history: [{ kind: "message", role: "user", messageId: "m1", parts: [{ kind: "text", text: "hi" }] }],
    artifacts: [{ artifactId: "a1", parts: [{ kind: "text", text: "reply" }] }],
  };
  const r = validateTask(task);
  assert.equal(r.ok, true, r.errors.join("; "));
});

test("an invalid TaskState is rejected", () => {
  const r = validateTask({ kind: "task", id: "t1", contextId: "c1", status: { state: "bogus" } });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("TaskState")));
});

test("validateMessage rejects an empty parts array", () => {
  const r = validateMessage({ kind: "message", role: "user", messageId: "m1", parts: [] });
  assert.equal(r.ok, false);
});

test("validateMessage accepts a text part", () => {
  const r = validateMessage({ kind: "message", role: "user", messageId: "m1", parts: [{ kind: "text", text: "hi" }] });
  assert.equal(r.ok, true, r.errors.join("; "));
});
