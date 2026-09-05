/**
 * test/a2a-tasks.test.ts — the Task store's idempotency, threading, bound
 * and expiry guarantees. Every test gets its own file under the sandboxed
 * HOME (test/home-guard.ts), passed explicitly so tests never share state.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOrThreadTask, getTask, setStatus, addArtifact, listAll, cleanupExpired,
} from "../src/a2a/tasks.js";

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), "a2a-tasks-")), "tasks.json");
}

test("createOrThreadTask+ creates a fresh task", () => {
  const file = tmpFile();
  const { task, created } = createOrThreadTask({ session: "Home", text: "hi", messageId: "m1" }, file);
  assert.equal(created, true);
  assert.equal(task.session, "Home");
  assert.equal(task.state, "submitted");
  assert.equal(task.history.length, 1);
});

test("idempotent on messageId+ — a repeated messageId returns the same task, no duplicate", () => {
  const file = tmpFile();
  const a = createOrThreadTask({ session: "Home", text: "hi", messageId: "dup-1" }, file);
  const b = createOrThreadTask({ session: "Home", text: "hi again", messageId: "dup-1" }, file);
  assert.equal(a.task.id, b.task.id);
  assert.equal(b.created, false);
  assert.equal(listAll(file).length, 1, "no second task was created");
});

test("contextId threads a follow-up onto the same open task+", () => {
  const file = tmpFile();
  const first = createOrThreadTask({ session: "Home", text: "first", messageId: "m1", contextId: "ctx-1" }, file);
  const second = createOrThreadTask({ session: "Home", text: "second", messageId: "m2", contextId: "ctx-1" }, file);
  assert.equal(first.task.id, second.task.id, "same contextId, still open, threads onto the same task");
  assert.equal(second.created, false);
  const task = getTask(first.task.id, file)!;
  assert.equal(task.history.length, 2);
  assert.equal(task.history[1].text, "second");
});

test("a terminal task does not absorb a later message with the same contextId-", () => {
  const file = tmpFile();
  const first = createOrThreadTask({ session: "Home", text: "first", messageId: "m1", contextId: "ctx-2" }, file);
  setStatus(first.task.id, "completed", {}, file);
  const second = createOrThreadTask({ session: "Home", text: "second", messageId: "m2", contextId: "ctx-2" }, file);
  assert.notEqual(first.task.id, second.task.id, "a new task starts once the old one reached a terminal state");
});

test("a reply to input-required re-opens the task as working+", () => {
  const file = tmpFile();
  const first = createOrThreadTask({ session: "Home", text: "first", messageId: "m1", contextId: "ctx-3" }, file);
  setStatus(first.task.id, "input-required", {}, file);
  const second = createOrThreadTask({ session: "Home", text: "answer", messageId: "m2", contextId: "ctx-3" }, file);
  assert.equal(second.task.id, first.task.id);
  assert.equal(getTask(first.task.id, file)!.state, "working");
});

test("setStatus and addArtifact+", () => {
  const file = tmpFile();
  const { task } = createOrThreadTask({ session: "Home", text: "hi", messageId: "m1" }, file);
  setStatus(task.id, "working", {}, file);
  assert.equal(getTask(task.id, file)!.state, "working");
  addArtifact(task.id, "the answer", { agentishOk: true }, file);
  const updated = getTask(task.id, file)!;
  assert.equal(updated.artifacts.length, 1);
  assert.equal(updated.artifacts[0].text, "the answer");
  assert.equal(updated.artifacts[0].agentishOk, true);
  // addArtifact also appends to history as an agent turn.
  assert.equal(updated.history.at(-1)!.role, "agent");
});

test("store bounded at 500+", () => {
  const file = tmpFile();
  for (let i = 0; i < 520; i++) {
    createOrThreadTask({ session: "Home", text: `msg ${i}`, messageId: `m${i}` }, file);
  }
  assert.equal(listAll(file).length, 500);
});

test("cleanupExpired removes a terminal task past 7 days, never an open one", () => {
  const file = tmpFile();
  const a = createOrThreadTask({ session: "Home", text: "old", messageId: "old-1" }, file);
  setStatus(a.task.id, "completed", {}, file);
  const b = createOrThreadTask({ session: "Home", text: "open", messageId: "open-1" }, file);

  const anchor = Date.parse(a.task.updatedAt);
  const justUnder = anchor + 6 * 24 * 60 * 60 * 1000;
  const justOver = anchor + 8 * 24 * 60 * 60 * 1000;

  assert.equal(cleanupExpired(file, justUnder), 0, "not expired yet");
  assert.equal(listAll(file).length, 2);

  const removed = cleanupExpired(file, justOver);
  assert.equal(removed, 1);
  const remainingIds = listAll(file).map((t) => t.id);
  assert.ok(!remainingIds.includes(a.task.id), "old terminal task removed");
  assert.ok(remainingIds.includes(b.task.id), "open task never removed, regardless of age");
});
