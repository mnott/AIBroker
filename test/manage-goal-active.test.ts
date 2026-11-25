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
import { mkdtempSync, writeFileSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGoalLine, foldHome, goalEvidenceLine, goalStillActiveInTranscript, reasonToArm, type ManagedSession } from "../src/daemon/manage.js";

const OBJ = "Audit every module and fix the drift.";

/**
 * The args a ceiling compares against: exactly what arm() types at the session
 * (buildGoalLine over the brief path), minus the leading `/goal `. Deriving it
 * from the same builder is the fix — comparing the stored objective against the
 * typed line always read "replaced" and re-armed a live goal every ceiling
 * (live failure 2026-11-25 05:42).
 */
function expectedArgs(m: ManagedSession): string {
  return buildGoalLine(foldHome(join(process.env.HOME ?? "", ".aibroker", "manage-briefs", `${m.name}.md`)), m.objective, m.shift?.until ?? null).replace(/^\/goal\s+/, "");
}

/** The real transcript record: `/goal` typed at the session, as Claude Code records it. */
function typedGoal(args: string, ts: string): string {
  return JSON.stringify({
    type: "user",
    timestamp: ts,
    message: { content: `<command-name>/goal</command-name>\n            <command-message>goal</command-message>\n            <command-args>${args}</command-args>` },
  });
}

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
  withFile([typedGoal(expectedArgs(base(NOW)), "2026-11-25T01:07:00.000Z"), assistant("2026-11-25T01:59:20.000Z")], (m) => {
    assert.equal(reasonToArm(m, ACTIVE_PANE, NOW), null);
  });
});

test("ceiling with a cleared goal — re-arm", () => {
  withFile([typedGoal(expectedArgs(base(NOW)), "2026-11-25T01:07:00.000Z"), goalClear("2026-11-25T01:40:00.000Z")], (m) => {
    const r = reasonToArm(m, ACTIVE_PANE, NOW);
    assert.match(r ?? "", /assuming it lapsed/);
  });
});

test("ceiling after a compaction — re-arm", () => {
  withFile([typedGoal(expectedArgs(base(NOW)), "2026-11-25T01:07:00.000Z"), compactBoundary("2026-11-25T01:50:00.000Z"), assistant("2026-11-25T01:59:20.000Z")], (m) => {
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
  withFile([typedGoal(expectedArgs(base(NOW)), "2026-11-25T01:07:00.000Z"), assistant("2026-11-25T01:59:20.000Z")], (m) => {
    m.lastRearmAt = NOW - 90 * 60_000; // far past the ceiling
    assert.equal(reasonToArm(m, ACTIVE_PANE, NOW), null);
  });
});

// ── the ceiling compared the STORED objective against the TYPED line ────────
// (live failure 2026-11-25 05:42)
/**
 * The scan now finds the real `/goal` entry, but the verdict still declared it
 * lapsed every ceiling: `ceilingReason` compared the stored objective with
 * `<command-args>`, and the args are what `buildGoalLine` types — a no-done-state
 * prefix, a brief pointer and a truncated objective. The two strings can never
 * be equal, so every goal read as "replaced" ("armed 46 min … assuming it
 * lapsed", live at 05:42:41). The ceiling now derives its expected text from the
 * SAME builder the arming path uses (`goalText` → `buildGoalLine`), so expected
 * and typed cannot drift, and whitespace reflow is tolerated.
 */
test("typed goal line in the transcript — no re-arm (the 05:42 live failure)", () => {
  // The shift's until is baked into the typed prefix ("Keep working until
  // …"), so the fixture and the manager under test must carry the SAME shift —
  // exactly what the live manager had at 05:42.
  const m = base(NOW);
  m.shift = { until: Date.parse("2026-11-25T07:00:00.000Z"), startedAt: NOW - 8 * 60_000 } as ManagedSession["shift"];
  withFile([typedGoal(expectedArgs(m), "2026-11-25T04:56:54.439Z"), assistant("2026-11-25T05:42:00.000Z")], (mm) => {
    mm.shift = m.shift;
    assert.equal(reasonToArm(mm, ACTIVE_PANE, NOW), null);
  });
});

test("whitespace reflow of the typed line is tolerated", () => {
  const m = base(NOW);
  const args = expectedArgs(m).replace(/ /g, "  "); // padded — a reflowed record
  const v = goalStillActiveInTranscript([typedGoal(args, "2026-11-25T01:07:00.000Z")], expectedArgs(m));
  assert.ok(v?.active);
});

test("a /goal with other args — replaced, lapsed", () => {
  const m = base(NOW);
  const v = goalStillActiveInTranscript([typedGoal("Fix something else entirely.", "2026-11-25T01:07:00.000Z")], expectedArgs(m));
  assert.ok(v);
  assert.equal(v.active, false);
});

test("the raw stored objective is NOT what the transcript holds — old compare lapsed", () => {
  // Pins the bug itself: the typed line contains the no-done-state prefix and a
  // brief pointer, so comparing the objective verbatim against it must be "not
  // active". Guards against anyone re-introducing `m.objective` as the compare.
  const m = base(NOW);
  const v = goalStillActiveInTranscript([typedGoal(expectedArgs(m), "2026-11-25T01:07:00.000Z")], OBJ);
  assert.ok(v);
  assert.equal(v.active, false);
});

test("no shift — the plain no-done-state line still matches", () => {
  withFile([typedGoal(expectedArgs(base(NOW)), "2026-11-25T01:07:00.000Z"), assistant("2026-11-25T01:59:20.000Z")], (m) => {
    assert.equal(reasonToArm(m, ACTIVE_PANE, NOW), null);
  });
});

test("shift with an until — the dated prefix matches and a bare objective does not", () => {
  const m = base(NOW);
  const until = Date.parse("2026-11-25T07:00:00.000Z");
  m.shift = { until, startedAt: NOW - 8 * 60_000 } as ManagedSession["shift"];
  const args = expectedArgs(m);
  // The prefix carries the local date/time of `until` (dateHhmm), not a fixed
  // UTC string — assert against the same formatter, not a literal.
  const d = new Date(until);
  const p = (n: number) => String(n).padStart(2, "0");
  assert.match(args, new RegExp(`Keep working until ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} \\d{2}:\\d{2}`));
  const v = goalStillActiveInTranscript([typedGoal(args, "2026-11-25T04:56:54.439Z")], args);
  assert.ok(v?.active);
});

test("goal cleared with the typed line present — lapsed", () => {
  withFile([typedGoal(expectedArgs(base(NOW)), "2026-11-25T01:07:00.000Z"), goalClear("2026-11-25T01:40:00.000Z")], (m) => {
    const r = reasonToArm(m, ACTIVE_PANE, NOW);
    assert.match(r ?? "", /assuming it lapsed/);
  });
});

test("compact_boundary after the typed line — lapsed", () => {
  withFile([typedGoal(expectedArgs(base(NOW)), "2026-11-25T01:07:00.000Z"), compactBoundary("2026-11-25T01:50:00.000Z")], (m) => {
    const r = reasonToArm(m, ACTIVE_PANE, NOW);
    assert.match(r ?? "", /assuming it lapsed/);
  });
});

test("goal met after the typed line — lapsed", () => {
  withFile([
    typedGoal(expectedArgs(base(NOW)), "2026-11-25T01:07:00.000Z"),
    JSON.stringify({ type: "user", timestamp: "2026-11-25T01:40:00.000Z", message: { role: "user", content: "The goal has been met." } }),
  ], (m) => {
    const r = reasonToArm(m, ACTIVE_PANE, NOW);
    assert.match(r ?? "", /assuming it lapsed/);
  });
});

test("the newest typed /goal wins — an older replacement lapses the managed one", () => {
  withFile([
    typedGoal(expectedArgs(base(NOW)), "2026-11-25T00:00:00.000Z"),
    typedGoal("Ship the release now.", "2026-11-25T01:30:00.000Z"),
  ], (m) => {
    const r = reasonToArm(m, ACTIVE_PANE, NOW);
    assert.match(r ?? "", /assuming it lapsed/);
  });
});

test("goalEvidenceLine accepts the real record shape", () => {
  assert.equal(goalEvidenceLine(typedGoal(expectedArgs(base(NOW)), "2026-11-25T04:56:54.439Z")), true);
});

// ── the tail was too short for a busy session (live failure 2026-11-25 03:25) ──

/**
 * A working session writes hundreds of tool lines between arming and the
 * ceiling. `tail -n 200` missed the last `/goal` in a 17.9 MB / 11280-line
 * transcript (the entry was 250 lines back) and re-armed a goal that was
 * plainly still active. The reader now scans backwards until it finds the
 * newest `/goal` or a `compact_boundary`, so distance from the end no longer
 * decides the verdict.
 */
function toolLines(n: number, startTs: string): string[] {
  const out: string[] = [];
  let t = Date.parse(startTs);
  for (let i = 0; i < n; i++) {
    t += 1_000;
    // An assistant tool-call line that CONTAINS the marker string — only a
    // type=="user" entry may count, so this must never be read as a /goal.
    out.push(
      JSON.stringify({
        type: "assistant",
        timestamp: new Date(t).toISOString(),
        message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: `grep -c 'command-name>/goal<' transcript.jsonl` } }] },
      }),
    );
  }
  return out;
}

function bigFile(lines: string[]): ManagedSession {
  const dir = mkdtempSync(join(tmpdir(), "aibroker-big-"));
  const file = join(dir, "s1.jsonl");
  writeFileSync(file, lines.join("\n") + "\n");
  const m = base(NOW);
  m.transcriptFile = file;
  return m;
}

test("goal 5000 tool lines before the end — still active, no re-arm", () => {
  const lines = [typedGoal(expectedArgs(base(NOW)), "2026-11-25T01:07:00.000Z"), ...toolLines(5_000, "2026-11-25T01:10:00.000Z")];
  const m = bigFile(lines);
  assert.equal(reasonToArm(m, ACTIVE_PANE, NOW), null);
});

test("compact_boundary after a deep goal — lapsed, re-arm", () => {
  const lines = [
    typedGoal(expectedArgs(base(NOW)), "2026-11-25T01:07:00.000Z"),
    ...toolLines(3_000, "2026-11-25T01:10:00.000Z"),
    compactBoundary("2026-11-25T01:55:00.000Z"),
    ...toolLines(1_000, "2026-11-25T01:56:00.000Z"),
  ];
  const m = bigFile(lines);
  assert.match(reasonToArm(m, ACTIVE_PANE, NOW) ?? "", /assuming it lapsed/);
});

test("assistant lines containing the marker string never count as a goal", () => {
  // No real /goal entry at all — only tool lines quoting the marker. Unknown,
  // so the ceiling's reading stands (re-arm), and a deep real goal still wins.
  const m = bigFile(toolLines(5_000, "2026-11-25T01:10:00.000Z"));
  assert.match(reasonToArm(m, ACTIVE_PANE, NOW) ?? "", /assuming it lapsed/);

  const m2 = bigFile([typedGoal(expectedArgs(base(NOW)), "2026-11-25T01:07:00.000Z"), ...toolLines(5_000, "2026-11-25T01:10:00.000Z")]);
  assert.equal(reasonToArm(m2, ACTIVE_PANE, NOW), null);
});

// ── the scan stopped on a QUOTED marker (live failure 2026-11-25 04:56) ────

/**
 * The backwards scan's stop test was `line.includes("/goal") ||
 * line.includes("compact_boundary")`. In a working session the newest megabytes
 * are full of assistant tool calls and tool results quoting those exact strings
 * — a `grep -c 'command-name>/goal<' transcript.jsonl` command, a read of
 * manage.ts, a hook reminder. The scan stopped inside that noise chunk before
 * reaching the real `/goal` user entry, the verdict found no qualifying entry,
 * and a goal typed 46 min earlier was declared lapsed ("armed … assuming it
 * lapsed" live at 04:56:56). The stop test now uses the verdict's own strict
 * predicate: a line counts only when it PARSES as JSON and IS a user `/goal`
 * entry or a system `compact_boundary` record.
 */
function noiseLines(n: number, startTs: string): string[] {
  const out: string[] = [];
  let t = Date.parse(startTs);
  for (let i = 0; i < n; i++) {
    t += 1_000;
    // ~700 bytes each, so `n` lines are > 1 MB of quoted-marker noise. Both
    // marker strings appear as TEXT inside tool calls and results — never as a
    // real record — so the strict predicate must skip every one of them.
    const pad = "x".repeat(700);
    out.push(
      JSON.stringify({
        type: "assistant",
        timestamp: new Date(t).toISOString(),
        message: { role: "assistant", content: [
          { type: "tool_use", name: "Bash", input: { command: `grep -c 'command-name>/goal<' ${pad} transcript.jsonl` } },
          { type: "text", text: `compact_boundary mentioned in this tool result ${pad}` },
        ] },
      }),
    );
  }
  return out;
}

test("noise quoting both markers after a deep goal — still active, no re-arm", () => {
  // > 2 MB fixture: one real /goal, then > 1 MB of assistant tool_use /
  // tool_result lines whose text contains "command-name>/goal<" and
  // "compact_boundary". Fails on the substring stop test; passes with the
  // strict shared predicate.
  const lines = [typedGoal(expectedArgs(base(NOW)), "2026-11-25T01:07:00.000Z"), ...noiseLines(3_000, "2026-11-25T01:10:00.000Z")];
  const m = bigFile(lines);
  assert.equal(reasonToArm(m, ACTIVE_PANE, NOW), null);
});

test("a real compact_boundary after a deep goal — lapsed, re-arm", () => {
  // The strict predicate must still STOP on a genuine boundary: noise quoted
  // around it, the real system record wins.
  const lines = [
    typedGoal(expectedArgs(base(NOW)), "2026-11-25T01:07:00.000Z"),
    ...noiseLines(1_500, "2026-11-25T01:10:00.000Z"),
    compactBoundary("2026-11-25T01:40:00.000Z"),
    ...noiseLines(1_500, "2026-11-25T01:41:00.000Z"),
  ];
  const m = bigFile(lines);
  assert.match(reasonToArm(m, ACTIVE_PANE, NOW) ?? "", /assuming it lapsed/);
});

test("goalEvidenceLine — quoting is never evidence", () => {
  assert.equal(goalEvidenceLine('{"type":"assistant","message":{"content":[{"input":{"command":"grep command-name>/goal< f"}}]}}'), false);
  assert.equal(goalEvidenceLine('{"type":"system","subtype":"other","content":"compact_boundary"}'), false);
  assert.equal(goalEvidenceLine("not json /goal"), false);
  assert.equal(goalEvidenceLine(""), false);
  assert.equal(goalEvidenceLine(userGoal(OBJ, "2026-11-25T01:07:00.000Z")), true);
  assert.equal(goalEvidenceLine(compactBoundary("2026-11-25T01:40:00.000Z")), true);
});

test("multi-byte content split across a chunk boundary is read whole", () => {
  // Pad so the goal line straddles the 1 MiB read boundary; its args contain
  // multi-byte characters that must survive the chunking.
  const obj = "Fix the drift — über alles ✓ 🎯";
  const pad = toolLines(2_000, "2026-11-25T01:00:00.000Z"); // ~2 MB of filler before the goal
  const lines = [...pad, typedGoal(expectedArgs({ ...base(NOW), objective: obj }), "2026-11-25T01:30:00.000Z"), ...toolLines(2_000, "2026-11-25T01:35:00.000Z")];
  const dir = mkdtempSync(join(tmpdir(), "aibroker-utf8-"));
  try {
    const file = join(dir, "s1.jsonl");
    writeFileSync(file, lines.join("\n") + "\n");
    const m = base(NOW);
    m.objective = obj;
    m.transcriptFile = file;
    assert.equal(reasonToArm(m, ACTIVE_PANE, NOW), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
