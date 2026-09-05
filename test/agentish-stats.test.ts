/**
 * test/agentish-stats.test.ts — is AG2 actually cheaper, on real traffic.
 *
 * agentishStats() reads the audit log, so these tests write a synthetic
 * slice of it — no real session names or paths, see CLAUDE.md — and read it
 * back through the same code path a real deployment would use.
 *
 * The audit file path is fixed at import time (see audit.ts), so it is set
 * BEFORE the first import, the same way test/audit.test.ts does it. All
 * tests in this file share one log; each scopes its query to its own day so
 * they cannot see each other's fixtures.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "aibroker-agentish-stats-"));
const AUDIT_FILE = join(DIR, "audit.jsonl");
process.env.AIBROKER_AUDIT_FILE = AUDIT_FILE;

const { agentishStats, formatStatsReport, approxTokens } = await import("../src/daemon/agentish-stats.js");
const { runAgentish } = await import("../src/daemon/agentish-cli.js");

const AG2_BODY = "R\ni=demo\nres=+\nchg=src/a.ts touched\ntest=One+\ngate=+\np=proof pasted";
const PROSE_BODY = "I finished the task and everything passed, including the gate and the one test I ran.";

let seq = 0;
function seed(actor: string, target: string, body: string, ts: string): void {
  seq += 1;
  const line = JSON.stringify({ id: `t-${seq}`, ts, action: "send", actor, target, outcome: "delivered", body });
  appendFileSync(AUDIT_FILE, line + "\n", "utf-8");
}

function window(day: string) {
  return { since: new Date(`${day}T00:00:00.000Z`), until: new Date(`${day}T23:59:59.999Z`) };
}

async function captureLogs(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try { await fn(); } finally { console.log = original; }
  return lines;
}

// ── classification and the numbers built on it ───────────────────────────────

test("stats-classifies-ag2-vs-prose+ a valid AG2 send and a prose send are told apart", () => {
  const day = "2026-09-10";
  seed("session:alpha", "session:beta", AG2_BODY, `${day}T10:00:00.000Z`);
  seed("session:alpha", "session:beta", PROSE_BODY, `${day}T10:01:00.000Z`);
  const r = agentishStats(window(day));
  assert.equal(r.ag2.count, 1);
  assert.equal(r.prose.count, 1);
});

test("stats-mean-and-ratio+ the ratio is prose mean over ag2 mean, computed from the same tokenizer", () => {
  const day = "2026-09-11";
  seed("session:alpha", "session:beta", AG2_BODY, `${day}T10:00:00.000Z`);
  seed("session:alpha", "session:beta", PROSE_BODY, `${day}T10:01:00.000Z`);
  const r = agentishStats(window(day));
  const ag2Tokens = approxTokens(AG2_BODY);
  const proseTokens = approxTokens(PROSE_BODY);
  assert.equal(r.ag2.meanTokens, ag2Tokens);
  assert.equal(r.prose.meanTokens, proseTokens);
  assert.ok(r.ratio !== null);
  assert.equal(r.ratio, proseTokens / ag2Tokens);
});

test("stats-since-filter+ a send before the window is excluded", () => {
  seed("session:alpha", "session:beta", AG2_BODY, "2026-09-12T10:00:00.000Z");
  seed("session:alpha", "session:beta", AG2_BODY, "2026-09-13T10:00:00.000Z");
  const r = agentishStats(window("2026-09-13"));
  assert.equal(r.ag2.count, 1);
});

test("stats-empty-log-says-no-data+ a window with nothing in it says so, not zero silently", () => {
  const r = agentishStats(window("2026-09-20"));
  assert.equal(r.ag2.count, 0);
  assert.equal(r.prose.count, 0);
  assert.equal(formatStatsReport(r), "no session-to-session sends found in the audit log for this range");
});

test("stats-per-day-table+ counts are broken out by calendar day", () => {
  seed("session:alpha", "session:beta", AG2_BODY, "2026-09-14T10:00:00.000Z");
  seed("session:alpha", "session:beta", AG2_BODY, "2026-09-15T10:00:00.000Z");
  seed("session:alpha", "session:beta", PROSE_BODY, "2026-09-15T11:00:00.000Z");
  const r = agentishStats({ since: new Date("2026-09-14T00:00:00.000Z"), until: new Date("2026-09-15T23:59:59.999Z") });
  assert.deepEqual(r.perDay, [
    { day: "2026-09-14", ag2: 1, prose: 0 },
    { day: "2026-09-15", ag2: 1, prose: 1 },
  ]);
});

test("stats-json-shape+ `agentish stats --json` prints the whole report as parseable JSON", async () => {
  seed("session:alpha", "session:beta", AG2_BODY, "2026-09-16T10:00:00.000Z");
  const out = await captureLogs(() => runAgentish(["stats", "--since", "2026-09-16", "--json"]));
  const parsed = JSON.parse(out.join("\n"));
  for (const key of ["ag2", "prose", "ratio", "perDay", "baseline", "heuristic"]) {
    assert.ok(key in parsed, `missing ${key} in JSON report`);
  }
  assert.equal(typeof parsed.ag2.count, "number");
});

test("stats-counts-bare-name-target+ a target with no session: prefix is still counted", () => {
  // The hub records the actor as `session:X` but often the target as a bare
  // display name (`CaseLeaf`, not `session:CaseLeaf`) — requiring the prefix
  // on both sides matched 0 of 1366 real sends and reported "no data" on a
  // full log. Only a transport-looking address (@, uds:, /) is excluded.
  const day = "2026-09-17";
  seed("session:alpha", "PlainName", AG2_BODY, `${day}T10:00:00.000Z`);
  const r = agentishStats(window(day));
  assert.equal(r.ag2.count, 1);
});

test("a transport-looking target (containing @, uds: or /) is excluded, not counted as a session", () => {
  const day = "2026-09-18";
  seed("session:alpha", "todoist:someone@example.com", AG2_BODY, `${day}T10:00:00.000Z`);
  seed("session:alpha", "uds:/tmp/some.sock", AG2_BODY, `${day}T10:01:00.000Z`);
  seed("session:alpha", "/absolute/path", AG2_BODY, `${day}T10:02:00.000Z`);
  const r = agentishStats(window(day));
  assert.equal(r.ag2.count, 0);
});

// ── the heuristic's documented bias ──────────────────────────────────────────

test("approxTokens-symbol-bias-documented+ equal-length symbol-dense text counts as more tokens than prose", () => {
  const symbolDense = "@a@a@a@a@a@a@a@a@a@a"; // 10 single-character symbol runs
  const prose = "aaaaaaaaaaaaaaaaaaaa"; // same length, no symbol runs at all
  assert.equal(symbolDense.length, prose.length);
  assert.ok(
    approxTokens(symbolDense) > approxTokens(prose),
    "a punctuation-dense message must not count as cheaper than equally long prose — that would hide, not just understate, AG2's true cost",
  );
});
