import "./home-guard.js";
/**
 * test/manage-goal-active.test.ts — the ceiling asks the transcript, not the clock.
 *
 * The 45-minute ceiling fired "armed … with no sign of a new goal" every ~46
 * min on a session whose goal was plainly still active (live 2026-11-25: the
 * same objective re-typed at 22:47, 23:35, 00:21, 01:07, 01:53, 02:39 while the
 * session kept working). `goalStillActiveInTranscript` reads the JSONL tail
 * oldest-first (`tail -n`): a user entry with `<command-name>/goal</command-name>` and
 * matching `<command-args>` is still in force; a later `/goal clear`, a
 * `compact_boundary` (compaction drops the goal from context), a Stop-hook
 * "condition met", or a replaced objective ends it. An unreadable tail returns
 * null — unknown never blocks recovery.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { goalStillActiveInTranscript, reasonToArm, type ManagedSession } from "../src/daemon/manage.js";

const OBJ = "Audit every module and fix the drift.";

function userGoal(args: string, ts: string): string {
  return JSON.stringify({
    type: "user",
    timestamp: ts,
    message: {
      role: "user",
      content: `<command-name>/goal</command-name>\n<command-args>${args}</command-args>\n<local-command-stdout>Goal set: ${args}</local-command-stdout>`,
    },
  });
}

function assistant(ts: string, text = "working"): string {
  return JSON.stringify({ type: "assistant", timestamp: ts, message: { role: "assistant", content: [{ type: "text", text }] } });
}

function compactBoundary(ts: string): string {
  return JSON.stringify({
    type: "system",
    subtype: "compact_boundary",
    timestamp: ts,
    compactMetadata: { trigger: "auto", preTokens: 784066, postTokens: 31163 },
  });
}

function goalClear(ts: string): string {
  return JSON.stringify({
    type: "user",
    timestamp: ts,
    message: { role: "user", content: "<command-name>/goal clear</command-name>\n<local-command-stdout>Goal cleared</local-command-stdout>" },
  });
}

function base(now: number): ManagedSession {
  return {
    sessionId: "s1",
    name: "s1",
    objective: OBJ,
    pending: [],
    history: [],
    lastRearmAt: now - 46 * 60_000,
    lastChangeAt: now - 40_000,
    lastHash: "h",
    paused: false,
  };
}

/** A pane showing the active-goal marker with an empty prompt — the ceiling's context. */
const ACTIVE_PANE = "/goal active\n❯ ";

// ── goalStillActiveInTranscript ────────────────────────────────────────────

test("active goal — same args, nothing after it ends it", () => {
  const tail = [userGoal(OBJ, "2026-11-25T01:07:00.000Z"), assistant("2026-11-25T01:10:00.000Z")];
  const v = goalStillActiveInTranscript(tail, OBJ);
  assert.ok(v);
  assert.equal(v.active, true);
  assert.equal(v.at, Date.parse("2026-11-25T01:07:00.000Z"));
});

test("cleared after the goal — lapsed", () => {
  const tail = [userGoal(OBJ, "2026-11-25T01:07:00.000Z"), goalClear("2026-11-25T01:20:00.000Z")];
  const v = goalStillActiveInTranscript(tail, OBJ);
  assert.ok(v);
  assert.equal(v.active, false);
});

test("compacted after the goal — lapsed (the goal left the context)", () => {
  const tail = [userGoal(OBJ, "2026-11-25T01:07:00.000Z"), compactBoundary("2026-11-25T01:25:00.000Z"), assistant("2026-11-25T01:30:00.000Z")];
  const v = goalStillActiveInTranscript(tail, OBJ);
  assert.ok(v);
  assert.equal(v.active, false);
});

test("goal met reported after the goal — lapsed", () => {
  const tail = [
    userGoal(OBJ, "2026-11-25T01:07:00.000Z"),
    JSON.stringify({ type: "user", timestamp: "2026-11-25T01:40:00.000Z", message: { role: "user", content: "The goal has been met." } }),
  ];
  const v = goalStillActiveInTranscript(tail, OBJ);
  assert.ok(v);
  assert.equal(v.active, false);
});

test("replaced by a different objective — lapsed", () => {
  const tail = [userGoal(OBJ, "2026-11-25T01:07:00.000Z"), userGoal("Something else entirely.", "2026-11-25T01:15:00.000Z")];
  const v = goalStillActiveInTranscript(tail, OBJ);
  assert.ok(v);
  assert.equal(v.active, false);
});

test("no /goal entry in the tail — unknown, never blocks recovery", () => {
  const tail = [assistant("2026-11-25T01:10:00.000Z")];
  assert.equal(goalStillActiveInTranscript(tail, OBJ), null);
});

test("truncated first line and garbage lines are skipped", () => {
  const tail = [
    '{"type":"assistant","timestamp":"2026-11-25T01:1', // truncated — normal when tailing
    "not json at all",
    userGoal(OBJ, "2026-11-25T01:07:00.000Z"),
  ];
  const v = goalStillActiveInTranscript(tail, OBJ);
  assert.ok(v?.active);
});

test("the newest /goal wins over an older one", () => {
  // An old arm of the managed objective, then a newer arm of something else:
  // only the most recent /goal decides.
  const tail = [userGoal(OBJ, "2026-11-25T00:00:00.000Z"), userGoal("Ship the release.", "2026-11-25T01:30:00.000Z")];
  const v = goalStillActiveInTranscript(tail, OBJ);
  assert.ok(v);
  assert.equal(v.active, false);
});

// ── reasonToArm through a real transcript file ─────────────────────────────

const NOW = Date.parse("2026-11-25T02:00:00.000Z");

function withFile(lines: string[], fn: (m: ManagedSession) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "aibroker-goal-"));
  try {
    const file = join(dir, "s1.jsonl");
    writeFileSync(file, lines.join("\n") + "\n");
    const m = base(NOW);
    m.transcriptFile = file;
    fn(m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("ceiling with an active goal in the transcript — no re-arm", () => {
  withFile([userGoal(OBJ, "2026-11-25T01:07:00.000Z"), assistant("2026-11-25T01:59:20.000Z")], (m) => {
    assert.equal(reasonToArm(m, ACTIVE_PANE, NOW), null);
  });
});

test("ceiling with a cleared goal — re-arm", () => {
  withFile([userGoal(OBJ, "2026-11-25T01:07:00.000Z"), goalClear("2026-11-25T01:40:00.000Z")], (m) => {
    const r = reasonToArm(m, ACTIVE_PANE, NOW);
    assert.match(r ?? "", /assuming it lapsed/);
  });
});

test("ceiling after a compaction — re-arm", () => {
  withFile([userGoal(OBJ, "2026-11-25T01:07:00.000Z"), compactBoundary("2026-11-25T01:50:00.000Z"), assistant("2026-11-25T01:59:20.000Z")], (m) => {
    const r = reasonToArm(m, ACTIVE_PANE, NOW);
    assert.match(r ?? "", /assuming it lapsed/);
  });
});

test("unreadable transcript file — the timer's reading stands (re-arm)", () => {
  const m = base(NOW);
  m.transcriptFile = join(tmpdir(), "aibroker-goal-does-not-exist.jsonl");
  const r = reasonToArm(m, ACTIVE_PANE, NOW);
  assert.match(r ?? "", /assuming it lapsed/);
});

test("goal still active but pane quiet — ceiling suppressed even past the age", () => {
  withFile([userGoal(OBJ, "2026-11-25T01:07:00.000Z"), assistant("2026-11-25T01:59:20.000Z")], (m) => {
    m.lastRearmAt = NOW - 90 * 60_000; // far past the ceiling
    assert.equal(reasonToArm(m, ACTIVE_PANE, NOW), null);
  });
});
