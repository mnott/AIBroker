/**
 * test/audit.test.ts — the cross-session trail.
 *
 * The motivating case is real: a smoke-test dispatch woke a session nobody had
 * touched in two weeks, that session surfaced a defect, the defect was relayed
 * to a third session already fixing it. Useful, unplanned, and knowable only
 * because the agent involved chose to mention it. These tests cover the part
 * that replaces self-report — chains reconstructable from the record alone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the trail at a temp file BEFORE importing the module — a real audit log
// with test fixtures in it is one you stop trusting.
const DIR = mkdtempSync(join(tmpdir(), "aibroker-audit-"));
process.env.AIBROKER_AUDIT_FILE = join(DIR, "audit.jsonl");

const { audit, noteInbound, readAudit, auditPath, newAuditId, resolveBody, INLINE_BODY_MAX } =
  await import("../src/daemon/audit.js");

const TAG = "t";

test("an event is appended and reads back", () => {
  const id = audit({ action: "send", actor: `${TAG}-A`, target: `${TAG}-B`, outcome: "delivered", body: "hello" });
  const found = readAudit({ session: `${TAG}-A` }).find((e) => e.id === id);
  assert.ok(found, "event should be readable");
  assert.equal(found!.action, "send");
  assert.equal(found!.body, "hello", "the body is the 'why' and must be kept verbatim");
  assert.match(found!.ts, /^\d{4}-\d{2}-\d{2}T/);
});

test("refusals are recorded, not just successes", () => {
  const id = audit({
    action: "refuse", actor: `${TAG}-A`, target: `${TAG}-shell`,
    outcome: "refused", body: "```echo hi```", reason: "target terminal is a shell",
  });
  const found = readAudit({ action: "refuse" }).find((e) => e.id === id);
  assert.ok(found);
  assert.match(found!.reason!, /shell/);
});

test("a three-hop chain is reconstructable from the record alone", () => {
  // Clickr → PAI → AIBroker, the shape that actually occurred.
  const hop1 = audit({ action: "send", actor: `${TAG}-Clickr`, target: `${TAG}-PAI`, outcome: "delivered", body: "found a bug" });
  noteInbound(`${TAG}-PAI`, hop1);

  const hop2 = audit({ action: "send", actor: `${TAG}-PAI`, target: `${TAG}-Broker`, outcome: "delivered", body: "relaying: found a bug" });
  noteInbound(`${TAG}-Broker`, hop2);

  const hop3 = audit({ action: "dispatch", actor: `${TAG}-Broker`, target: `${TAG}-Youdrill`, outcome: "delivered", body: "please check" });

  const chain = readAudit({ trace: hop3 });
  const ids = chain.map((e) => e.id);
  assert.ok(ids.includes(hop1), "tracing from the end must reach the origin");
  assert.ok(ids.includes(hop2));
  assert.ok(ids.includes(hop3));
});

test("tracing from the origin finds what it led to", () => {
  const root = audit({ action: "send", actor: `${TAG}-Root`, target: `${TAG}-Mid`, outcome: "delivered", body: "go" });
  noteInbound(`${TAG}-Mid`, root);
  const leaf = audit({ action: "launch", actor: `${TAG}-Mid`, target: `${TAG}-New`, outcome: "spawned" });

  const ids = readAudit({ trace: root }).map((e) => e.id);
  assert.ok(ids.includes(leaf), "downstream consequences must be reachable from the cause");
});

test("an unrelated event is not pulled into a chain", () => {
  const root = audit({ action: "send", actor: `${TAG}-R2`, target: `${TAG}-M2`, outcome: "delivered", body: "x" });
  noteInbound(`${TAG}-M2`, root);
  const unrelated = audit({ action: "send", actor: `${TAG}-Zed`, target: `${TAG}-Other`, outcome: "delivered", body: "y" });

  const ids = readAudit({ trace: root }).map((e) => e.id);
  assert.ok(!ids.includes(unrelated), "causation must not be inferred between strangers");
});

test("filtering by session matches actor OR target", () => {
  const id = audit({ action: "ask", actor: `${TAG}-Asker`, target: `${TAG}-Askee`, outcome: "replied" });
  assert.ok(readAudit({ session: `${TAG}-Askee` }).some((e) => e.id === id), "being acted upon counts");
  assert.ok(readAudit({ session: `${TAG}-Asker` }).some((e) => e.id === id), "acting counts");
});

test("auditing never throws, whatever it is handed", () => {
  // It must not be able to break the operation it is recording.
  assert.doesNotThrow(() => audit({ action: "send", actor: "", target: "", outcome: "" }));
  assert.doesNotThrow(() => audit({
    action: "send", actor: `${TAG}-big`, target: "t", outcome: "ok",
    body: "x".repeat(200_000),
  }));
});

test("the log is one JSON object per line", () => {
  // The format is the durability guarantee: a torn final line costs one record,
  // not the file, and anything can append to it.
  assert.ok(existsSync(auditPath()));
  const lines = readFileSync(auditPath(), "utf-8").split("\n").filter((l) => l.trim());
  for (const l of lines.slice(-20)) {
    assert.doesNotThrow(() => JSON.parse(l), `not valid JSON: ${l.slice(0, 80)}`);
  }
});

// ── multi-writer contract ───────────────────────────────────────────────────
//
// This file is meant to have more than one producer. An O_APPEND write is only
// atomic up to a small kernel limit (512 bytes on macOS), so a multi-KB line
// can interleave with another writer's and corrupt the file — the exact failure
// the format exists to avoid, arriving through the door left open by storing
// bodies in full. Real lines here already reached 3.5KB with one writer.

test("a large body is spilled so the LINE stays small", () => {
  const big = "x".repeat(50_000);
  const id = audit({ action: "send", actor: `${TAG}-A`, target: `${TAG}-B`, outcome: "delivered", body: big });

  const line = readFileSync(auditPath(), "utf-8").split("\n").filter(Boolean).find((l) => l.includes(id))!;
  assert.ok(line.length < 2_000, `line is ${line.length} bytes — must stay small for atomic append`);

  const ev = readAudit({ session: `${TAG}-A` }).find((e) => e.id === id)!;
  assert.ok(ev.bodyRef, "a spilled body must be referenced by hash");
  assert.equal(ev.bodyBytes, 50_000, "the true size is recorded so a preview is obvious");
  assert.equal(resolveBody(ev), big, "and the full body is still recoverable");
});

test("no line exceeds the atomic-append budget, whatever is thrown at it", () => {
  audit({
    action: "ask", actor: `${TAG}-A`, target: `${TAG}-B`, outcome: "replied",
    body: "y".repeat(80_000),
    meta: { reply: "z".repeat(80_000) },   // meta is free-form and must be bounded too
  });
  const lines = readFileSync(auditPath(), "utf-8").split("\n").filter(Boolean);
  for (const l of lines) {
    assert.ok(l.length < 4_096, `a ${l.length}-byte line can interleave with another writer`);
  }
});

test("a small body stays inline — no sidecar for the common case", () => {
  const id = audit({ action: "send", actor: `${TAG}-A`, target: `${TAG}-B`, outcome: "delivered", body: "short" });
  const ev = readAudit({ session: `${TAG}-A` }).find((e) => e.id === id)!;
  assert.equal(ev.body, "short");
  assert.equal(ev.bodyRef, undefined);
  assert.equal(resolveBody(ev), "short");
});

test("identical bodies share one sidecar", () => {
  const body = "q".repeat(INLINE_BODY_MAX + 500);
  const a = audit({ action: "send", actor: `${TAG}-A`, target: `${TAG}-B`, outcome: "delivered", body });
  const b = audit({ action: "send", actor: `${TAG}-A`, target: `${TAG}-B`, outcome: "delivered", body });
  const evs = readAudit({ session: `${TAG}-A` });
  const ra = evs.find((e) => e.id === a)!.bodyRef;
  const rb = evs.find((e) => e.id === b)!.bodyRef;
  assert.equal(ra, rb, "content addressing means a repeated body costs one file");
});

test("a missing sidecar degrades loudly rather than returning a silent truncation", () => {
  const ev = { id: "x", ts: "", action: "send", actor: "a", target: "b", outcome: "ok",
    body: "preview", bodyRef: "0".repeat(64), bodyBytes: 9999 };
  const out = resolveBody(ev)!;
  assert.match(out, /full body unavailable/, "a truncated body must not pass as whole");
});

test("ids are namespaced, sortable and unique", () => {
  // The shape other producers replicate: `<ns>-<base36 ms>-<base36 random>`.
  const id = newAuditId();
  assert.match(id, /^ab-[0-9a-z]+-[0-9a-z]{6}$/);
  assert.ok(newAuditId("pai").startsWith("pai-"), "another writer namespaces its own ids");

  const ids = new Set(Array.from({ length: 5_000 }, () => newAuditId()));
  assert.equal(ids.size, 5_000, "no collisions within a burst");

  const [a, b] = [newAuditId(), newAuditId()];
  assert.ok(a.split("-")[1] <= b.split("-")[1], "the time component sorts chronologically");
});

test("ids from different producers never collide", () => {
  const mine = new Set(Array.from({ length: 2_000 }, () => newAuditId("ab")));
  const theirs = Array.from({ length: 2_000 }, () => newAuditId("pai"));
  assert.ok(theirs.every((t) => !mine.has(t)), "the namespace alone guarantees this");
});

test("a truncated trailing line does not break reading", () => {
  const before = readAudit({ session: TAG }).length;
  appendFileSync(auditPath(), '{"id":"trunc","ts":"2026', "utf-8");
  assert.doesNotThrow(() => readAudit({ session: TAG }));
  assert.equal(readAudit({ session: TAG }).length, before, "the bad line is skipped, the rest survives");
  appendFileSync(auditPath(), "\n", "utf-8");
});
