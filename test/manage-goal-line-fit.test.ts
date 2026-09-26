import "./home-guard.js";
/**
 * test/manage-goal-line-fit.test.ts — the line typed at a session must stay
 * a command, never become a paste.
 *
 * Proven from a live transcript on 2026-09-24: pasting a `/goal …` line over
 * roughly 1,000 characters gets converted into a `<pasted_content>`
 * attachment instead of typed input on Claude Code 2.1.280, so the leading
 * `/goal` never runs as a slash command — no goal is set, and the manager
 * retypes the same failing line forever. fitGoalLine keeps the typed line
 * under a hard cap by shrinking everything around the objective first.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { fitGoalLine } from "../src/daemon/manage.js";

const AGENTISH = "T\ni=x\ng=goal\nd=do";
const RULES_POINTER =
  "FIRST, before anything else: read ~/.aibroker/manage-rules.txt and follow every rule in it for the whole of this work — they are not optional and they are not summarised here.";
const SCREEN_GRANT =
  "YOU HAVE THE SCREEN until 08:00 — the grant is recorded and renewed for you, so do not hand the controls back.";

test("a line that already fits is returned unchanged", () => {
  const parts = { objective: "do the small thing", agentish: "T", rulesPointer: "", screenGrant: "" };
  const line = fitGoalLine(parts, 700);
  assert.equal(line, "/goal T do the small thing");
});

test("an over-long line drops the AG2 header first and keeps the objective verbatim", () => {
  const objective = "do the work on this issue and report back when finished";
  const parts = { objective, agentish: AGENTISH, rulesPointer: "", screenGrant: "" };
  const line = fitGoalLine(parts, 65);
  assert.ok(!line.includes(AGENTISH), "AG2 header should have been dropped");
  assert.ok(line.includes(objective), "objective must survive verbatim once the header is dropped");
});

test("result is always at most max chars and always starts with /goal ", () => {
  const cases = [
    { objective: "x".repeat(5), agentish: "", rulesPointer: "", screenGrant: "" },
    { objective: "x".repeat(50), agentish: AGENTISH, rulesPointer: RULES_POINTER, screenGrant: SCREEN_GRANT },
    { objective: "y".repeat(2000), agentish: AGENTISH, rulesPointer: RULES_POINTER, screenGrant: SCREEN_GRANT },
  ];
  for (const parts of cases) {
    const line = fitGoalLine(parts, 700);
    assert.ok(line.length <= 700, `expected <= 700, got ${line.length}`);
    assert.ok(line.startsWith("/goal "), `expected to start with "/goal ", got "${line.slice(0, 20)}"`);
  }
});

test("the objective's first 40 chars are always present in the fitted line", () => {
  const objective = "work the open issues in this repository's tracker one at a time and do not stop";
  const parts = { objective, agentish: AGENTISH, rulesPointer: RULES_POINTER, screenGrant: SCREEN_GRANT };
  const line = fitGoalLine(parts, 700);
  assert.ok(line.includes(objective.slice(0, 40)));
});

test("a 1,200-char input fits under 700", () => {
  const objective = "z".repeat(1200);
  const parts = { objective, agentish: AGENTISH, rulesPointer: RULES_POINTER, screenGrant: SCREEN_GRANT };
  const line = fitGoalLine(parts, 700);
  assert.ok(line.length <= 700, `expected <= 700, got ${line.length}`);
  assert.ok(line.startsWith("/goal "));
});
