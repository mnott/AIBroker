import "./home-guard.js";
/**
 * test/inbound-held.test.ts — events held for coalescing survive a restart.
 * Live case 2026-11-08: a forge comment held 25s, daemon restarted, never delivered.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const created: string[] = [];
const realReply = await import("../src/daemon/todoist-reply.js");
mock.module("../src/daemon/todoist-reply.js", {
  namedExports: { ...realReply, createTask: async (_t: string, o: any) => { created.push(o.description); return { taskId: `t${created.length}` }; } },
});
const I = await import("../src/daemon/inbound.js");

const file = () => join(homedir(), ".aibroker", "inbound-held.json");
const groups = () => (existsSync(file()) ? JSON.parse(readFileSync(file(), "utf-8")).groups : []);
const ev = (n: number, body: string) => ({ action: "created", issue: { number: n }, comment: { body } });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

I.addRoute("held-route", { owner: "some-session", mode: "task", coalesce: { ms: 400, key: "issue.number" } });
const route = () => I.findRoute("held-route")!;

test("a held group is persisted, and updated when it grows", async () => {
  created.length = 0;
  const r = await I.deliverInbound(route(), ev(7, "first"));
  assert.match(r.detail, /held for grouping/);
  assert.equal(groups().length, 1);
  assert.equal(groups()[0].events.length, 1);
  await I.deliverInbound(route(), ev(7, "second"));
  assert.equal(groups()[0].events.length, 2);
  assert.equal(created.length, 0);
});

test("restart: reload delivers the group once and removes it from disk", async () => {
  I.__dropHeldMemory(); // process gone, file stays
  assert.equal(groups().length, 1);
  assert.equal(I.recoverHeldGroups(), 1);
  await wait(900);
  assert.equal(created.length, 1);
  assert.match(created[0], /first/);
  assert.match(created[0], /second/);
  assert.equal(groups().length, 0);
});

test("an overdue group is delivered at once on start", async () => {
  created.length = 0;
  await I.deliverInbound(route(), ev(8, "late"));
  I.__dropHeldMemory();
  await wait(500);
  assert.equal(I.recoverHeldGroups(), 1);
  await wait(100);
  assert.equal(created.length, 1);
  assert.equal(groups().length, 0);
});

test("flush then reload does not deliver twice", async () => {
  created.length = 0;
  await I.deliverInbound(route(), ev(9, "flushme"));
  await I.flushHeldGroups();
  assert.equal(created.length, 1);
  assert.equal(groups().length, 0);
  I.__dropHeldMemory();
  assert.equal(I.recoverHeldGroups(), 0);
  await wait(600);
  assert.equal(created.length, 1);
});
