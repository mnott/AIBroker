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

const { audit, noteInbound, readAudit, auditPath } = await import("../src/daemon/audit.js");

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

test("a truncated trailing line does not break reading", () => {
  const before = readAudit({ session: TAG }).length;
  appendFileSync(auditPath(), '{"id":"trunc","ts":"2026', "utf-8");
  assert.doesNotThrow(() => readAudit({ session: TAG }));
  assert.equal(readAudit({ session: TAG }).length, before, "the bad line is skipped, the rest survives");
  appendFileSync(auditPath(), "\n", "utf-8");
});
