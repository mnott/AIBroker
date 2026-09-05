/**
 * test/a2a-client.test.ts — the client against a real handleA2A server on
 * loopback. Exercises the same client this project's own `aibroker a2a`
 * CLI and `aibroker_a2a_send` MCP tool use, which is also what makes
 * `aibroker a2a check` usable against an agent aibroker did not write.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleA2A, applyA2AReply, type A2AContext } from "../src/a2a/server.js";
import { expose } from "../src/a2a/exposure.js";
import { fetchAgentCard, sendMessage, getTask, cancelTask, pollUntilDone } from "../src/a2a/client.js";

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), "a2a-client-"));
  const taskFile = join(dir, "tasks.json");
  const exposureFile = join(dir, "exposed.json");
  expose("Home", undefined, exposureFile);
  const ctx: A2AContext = {
    version: "0.0.0-test",
    publicUrl: () => "will be overwritten below",
    token: "s3cr3t",
    deliver: async () => ({ delivered: true }),
    taskFile,
    exposureFile,
  };
  const server = createServer((req, res) => { void handleA2A(req, res, ctx); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  ctx.publicUrl = () => `${base}/a2a`;
  return { server, base, a2aUrl: `${base}/a2a`, taskFile };
}

async function stop(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test("client-card+ fetchAgentCard validates and returns the card", async () => {
  const h = await harness();
  try {
    const r = await fetchAgentCard(h.base);
    assert.equal(r.ok, true, r.errors.join("; "));
    assert.equal(r.card!.name, "aibroker");
  } finally { await stop(h.server); }
});

test("fetchAgentCard reports errors when nothing is listening", async () => {
  // A path-only base ("/nope") would be ignored by `new URL(path, base)` — a
  // real card fetch against an unreachable host is the honest way to force
  // fetchAgentCard's failure path.
  const r = await fetchAgentCard("http://127.0.0.1:1");
  assert.equal(r.ok, false);
  assert.ok(r.errors.length > 0);
});

test("client-send+ sendMessage returns a validated Task", async () => {
  const h = await harness();
  try {
    const r = await sendMessage(h.a2aUrl, { skillId: "Home", text: "hello", token: "s3cr3t" });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.task!.status.state, "working");
  } finally { await stop(h.server); }
});

test("sendMessage surfaces a wrong-token failure", async () => {
  const h = await harness();
  try {
    const r = await sendMessage(h.a2aUrl, { skillId: "Home", text: "hello", token: "nope" });
    assert.equal(r.ok, false);
  } finally { await stop(h.server); }
});

test("getTask and cancelTask round-trip", async () => {
  const h = await harness();
  try {
    const sent = await sendMessage(h.a2aUrl, { skillId: "Home", text: "hello", token: "s3cr3t" });
    const got = await getTask(h.a2aUrl, sent.task!.id, "s3cr3t");
    assert.equal(got.ok, true);
    assert.equal(got.task!.id, sent.task!.id);

    const canceled = await cancelTask(h.a2aUrl, sent.task!.id, "s3cr3t");
    assert.equal(canceled.ok, true);
    assert.equal(canceled.task!.status.state, "canceled");
  } finally { await stop(h.server); }
});

test("client-poll-completes+ pollUntilDone resolves once a reply completes the task", async () => {
  const h = await harness();
  try {
    const sent = await sendMessage(h.a2aUrl, { skillId: "Home", text: "please answer", token: "s3cr3t" });
    assert.equal(sent.ok, true);

    // Simulate the session replying while the poll is in flight.
    setTimeout(() => { applyA2AReply(sent.task!.id, "here is your answer", h.taskFile); }, 200);

    const done = await pollUntilDone(h.a2aUrl, sent.task!.id, { intervalMs: 100, timeoutMs: 5000, token: "s3cr3t" });
    assert.equal(done.ok, true);
    assert.equal(done.task!.status.state, "completed");
  } finally { await stop(h.server); }
});

test("pollUntilDone times out on a task that never reaches a terminal state", async () => {
  const h = await harness();
  try {
    const sent = await sendMessage(h.a2aUrl, { skillId: "Home", text: "please answer", token: "s3cr3t" });
    const done = await pollUntilDone(h.a2aUrl, sent.task!.id, { intervalMs: 50, timeoutMs: 300, token: "s3cr3t" });
    assert.equal(done.ok, false);
  } finally { await stop(h.server); }
});
