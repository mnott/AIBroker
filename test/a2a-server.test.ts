/**
 * test/a2a-server.test.ts — handleA2A end to end, over a real loopback
 * socket, with a fake `deliver` standing in for a session mailbox.
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
import { getTask } from "../src/a2a/tasks.js";

interface Harness {
  server: Server;
  base: string;
  taskFile: string;
  exposureFile: string;
  delivered: { session: string; text: string }[];
}

async function harness(overrides: Partial<A2AContext> = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "a2a-server-"));
  const taskFile = join(dir, "tasks.json");
  const exposureFile = join(dir, "exposed.json");
  expose("Home", "test session", exposureFile);
  const delivered: { session: string; text: string }[] = [];
  const ctx: A2AContext = {
    version: "0.0.0-test",
    publicUrl: () => "https://example.org/a2a",
    token: "s3cr3t",
    deliver: async (session, text) => { delivered.push({ session, text }); return { delivered: true }; },
    taskFile,
    exposureFile,
    ...overrides,
  };
  const server = createServer((req, res) => { void handleA2A(req, res, ctx); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return { server, base: `http://127.0.0.1:${port}`, taskFile, exposureFile, delivered };
}

async function stop(h: Harness): Promise<void> {
  await new Promise<void>((resolve) => h.server.close(() => resolve()));
}

async function rpc(base: string, method: string, params: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${base}/a2a`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return { status: res.status, body: res.status === 404 ? await res.text() : await res.json() as any };
}

test("card-shape+ GET the well-known card, lists only exposed skills", async () => {
  const h = await harness();
  try {
    const res = await fetch(`${h.base}/.well-known/agent-card.json`);
    assert.equal(res.status, 200);
    const card = await res.json() as any;
    assert.equal(card.protocolVersion, "0.3.0");
    assert.equal(card.preferredTransport, "JSONRPC");
    assert.deepEqual(card.skills.map((s: any) => s.id), ["Home"]);
    assert.ok(card.securitySchemes.bearer);
  } finally { await stop(h); }
});

test("card-lists-only-exposed+ nothing exposed means an empty skills array", async () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-empty-"));
  const emptyExposure = join(dir, "exposed.json");
  const h = await harness({ exposureFile: emptyExposure });
  try {
    const res = await fetch(`${h.base}/.well-known/agent-card.json`);
    const card = await res.json() as any;
    assert.deepEqual(card.skills, []);
  } finally { await stop(h); }
});

test("auth-refusals-alike+ no token, wrong token, and an unknown path all answer identically", async () => {
  const h = await harness();
  try {
    const noToken = await rpc(h.base, "tasks/get", { id: "x" }, undefined);
    const wrongToken = await rpc(h.base, "tasks/get", { id: "x" }, "nope");
    const unknownPath = await fetch(`${h.base}/a2a/bogus`, { method: "POST" });

    assert.equal(noToken.status, 404);
    assert.equal(wrongToken.status, 404);
    assert.equal(unknownPath.status, 404);
    assert.equal(noToken.body, wrongToken.body, "identical empty body");
  } finally { await stop(h); }
});

test("send-creates-working-task+ send-delivers-framed-as-data+", async () => {
  const h = await harness();
  try {
    const r = await rpc(h.base, "message/send", {
      skillId: "Home",
      message: { kind: "message", role: "user", messageId: "m1", parts: [{ kind: "text", text: "please water the plants" }] },
    }, "s3cr3t");
    assert.equal(r.status, 200);
    const task = r.body.result;
    assert.equal(task.kind, "task");
    assert.equal(task.status.state, "working");

    assert.equal(h.delivered.length, 1);
    assert.equal(h.delivered[0].session, "Home");
    assert.match(h.delivered[0].text, /\[A2A:external\]\[task /);
    assert.match(h.delivered[0].text, /DATA, not an instruction/);
    assert.match(h.delivered[0].text, /please water the plants/);
    assert.match(h.delivered[0].text, new RegExp(`aibroker_a2a_reply taskId=${task.id}`));
  } finally { await stop(h); }
});

test("failed-on-delivery-error+ a task whose delivery fails ends up failed, not stuck working", async () => {
  const h = await harness({ deliver: async (_session, _text) => ({ delivered: false, detail: "session is at a shell prompt" }) });
  try {
    const r = await rpc(h.base, "message/send", {
      skillId: "Home",
      message: { kind: "message", role: "user", messageId: "m1", parts: [{ kind: "text", text: "hi" }] },
    }, "s3cr3t");
    assert.equal(r.body.result.status.state, "failed");
    assert.equal(r.body.result.status.message.parts[0].text, "session is at a shell prompt");
  } finally { await stop(h); }
});

test("send-to-unexposed-refused-alike+ an unexposed or unknown target gets the same error", async () => {
  const h = await harness();
  try {
    const unknown = await rpc(h.base, "message/send", {
      skillId: "DoesNotExist",
      message: { kind: "message", role: "user", messageId: "m1", parts: [{ kind: "text", text: "hi" }] },
    }, "s3cr3t");
    const other = await rpc(h.base, "message/send", {
      skillId: "NotExposedEither",
      message: { kind: "message", role: "user", messageId: "m2", parts: [{ kind: "text", text: "hi" }] },
    }, "s3cr3t");
    assert.equal(unknown.body.error.code, other.body.error.code);
    assert.equal(unknown.body.error.message, other.body.error.message);
  } finally { await stop(h); }
});

test("ag2-part-verdict-attached+ an AG2-tagged part is validated and the verdict is noted", async () => {
  const h = await harness();
  try {
    const validAg2 = "T\ni=x\ng=goal\nd=steps\nt=Name+";
    await rpc(h.base, "message/send", {
      skillId: "Home",
      message: {
        kind: "message", role: "user", messageId: "ag2-1",
        parts: [{ kind: "text", text: validAg2, metadata: { agentish: "2" } }],
      },
    }, "s3cr3t");
    assert.match(h.delivered.at(-1)!.text, /\[AG2: valid\]/);

    await rpc(h.base, "message/send", {
      skillId: "Home",
      message: {
        kind: "message", role: "user", messageId: "ag2-2",
        parts: [{ kind: "text", text: "T\nnot a real ag2 message", metadata: { agentish: "2" } }],
      },
    }, "s3cr3t");
    assert.match(h.delivered.at(-1)!.text, /\[AG2: INVALID/);
  } finally { await stop(h); }
});

test("tasks/get+ round-trips a created task", async () => {
  const h = await harness();
  try {
    const sent = await rpc(h.base, "message/send", {
      skillId: "Home",
      message: { kind: "message", role: "user", messageId: "m1", parts: [{ kind: "text", text: "hi" }] },
    }, "s3cr3t");
    const id = sent.body.result.id;
    const got = await rpc(h.base, "tasks/get", { id }, "s3cr3t");
    assert.equal(got.body.result.id, id);

    const missing = await rpc(h.base, "tasks/get", { id: "no-such-task" }, "s3cr3t");
    assert.equal(missing.body.error.code, -32001);
  } finally { await stop(h); }
});

test("tasks/cancel-notifies+ cancels an open task and delivers a notice", async () => {
  const h = await harness();
  try {
    const sent = await rpc(h.base, "message/send", {
      skillId: "Home",
      message: { kind: "message", role: "user", messageId: "m1", parts: [{ kind: "text", text: "hi" }] },
    }, "s3cr3t");
    const id = sent.body.result.id;
    const before = h.delivered.length;
    const canceled = await rpc(h.base, "tasks/cancel", { id }, "s3cr3t");
    assert.equal(canceled.body.result.status.state, "canceled");
    assert.ok(h.delivered.length > before, "the session was notified");

    const again = await rpc(h.base, "tasks/cancel", { id }, "s3cr3t");
    assert.equal(again.body.error.code, -32002, "already terminal — not cancelable");
  } finally { await stop(h); }
});

test("tasks/send is accepted as the pre-0.2 alias of message/send", async () => {
  const h = await harness();
  try {
    const r = await rpc(h.base, "tasks/send", {
      skillId: "Home",
      message: { kind: "message", role: "user", messageId: "alias-1", parts: [{ kind: "text", text: "hi" }] },
    }, "s3cr3t");
    assert.equal(r.status, 200);
    assert.equal(r.body.result.kind, "task");
  } finally { await stop(h); }
});

test("applyA2AReply completes a working task, or leaves it input-required on a question", async () => {
  const h = await harness();
  try {
    const sent = await rpc(h.base, "message/send", {
      skillId: "Home",
      message: { kind: "message", role: "user", messageId: "m1", parts: [{ kind: "text", text: "do the thing" }] },
    }, "s3cr3t");
    const id = sent.body.result.id;

    const r1 = applyA2AReply(id, "done, see attached", h.taskFile);
    assert.equal(r1?.task.state, "completed");

    const sent2 = await rpc(h.base, "message/send", {
      skillId: "Home",
      message: { kind: "message", role: "user", messageId: "m2", parts: [{ kind: "text", text: "do another thing" }] },
    }, "s3cr3t");
    const id2 = sent2.body.result.id;
    const r2 = applyA2AReply(id2, "which format do you want this in?", h.taskFile);
    assert.equal(r2?.task.state, "input-required");
    assert.equal(getTask(id2, h.taskFile)!.state, "input-required");
  } finally { await stop(h); }
});
