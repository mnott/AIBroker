import "./home-guard.js";
/**
 * A `claude attach <id>` viewer sits in HOME, so its cwd names the wrong
 * project; the session id names the right file. And a turn that ended with
 * nothing running is a stop, detected within a tick.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionTranscriptFile, turnStoppedIdle, liveTranscriptTail } from "../src/daemon/manage.js";

const UUID = "cdd93e8d-458c-4a63-a9cf-c24488cdd6f4";
const RULE = "──────────────────────────────────────────────────────────────────";
const pane = (status: string, input = "❯  ") => [status, RULE, input, RULE, "  PAI CC"].join("\n");

function projects(): string {
  const root = mkdtempSync(join(tmpdir(), "st-"));
  mkdirSync(join(root, "-home-user"));
  mkdirSync(join(root, "-apps-CaseLeaf"));
  writeFileSync(join(root, "-home-user", "stale.jsonl"), JSON.stringify({ type: "assistant", timestamp: "2026-10-12T01:00:00Z" }) + "\n");
  writeFileSync(join(root, "-apps-CaseLeaf", `${UUID}.jsonl`), JSON.stringify({ type: "assistant", timestamp: "2026-10-12T19:00:00Z" }) + "\n");
  return root;
}

test("attach short id resolves to the uuid file in the right project, not the HOME project", () => {
  const root = projects();
  assert.equal(sessionTranscriptFile("cdd93e8d", root), join(root, "-apps-CaseLeaf", `${UUID}.jsonl`));
  assert.equal(sessionTranscriptFile(UUID, root), join(root, "-apps-CaseLeaf", `${UUID}.jsonl`));
});

test("cache re-resolves when the file disappears; unknown id -> null", () => {
  const root = projects();
  const first = sessionTranscriptFile("cdd93e8d", root)!;
  rmSync(first);
  writeFileSync(join(root, "-home-user", `${UUID}.jsonl`), "{}\n");
  assert.equal(sessionTranscriptFile("cdd93e8d", root), join(root, "-home-user", `${UUID}.jsonl`));
  assert.equal(sessionTranscriptFile("deadbeef", root), null);
});

test("foreground (no id): newest-in-project heuristic unchanged", () => {
  const root = projects();
  assert.equal(liveTranscriptTail(join(root, "-apps-CaseLeaf"))?.file, `${UUID}.jsonl`);
});

const NOW = Date.parse("2026-10-12T20:00:00Z");
const ended = { working: false, lastAt: NOW - 60_000 };

test("ended turn, empty prompt, nothing running -> stopped now", () => {
  assert.equal(turnStoppedIdle(ended, pane("✻ Brewed for 4m 33s"), NOW), true);
});

test("ended turn with background shells running -> not stopped", () => {
  assert.equal(turnStoppedIdle(ended, pane("✻ Brewed for 4m · 1 shell still running"), NOW), false);
});

const live = (footer: string, status = "✻ Worked for 2m · done 21:47", input = "❯  ") =>
  ["⏺ Report text", "", status, RULE, input, RULE, footer].join("\n");

test("idle with ▶N worker footer -> not stopped", () => {
  assert.equal(turnStoppedIdle(ended, live("  🐝 anthropic ▶3 · sonnet-5.5 ×3 · oldest 12m"), NOW), false);
});

test("idle with '← N agents · N shell' footer only -> stopped", () => {
  assert.equal(turnStoppedIdle(ended, live("  PAI CC · ← 4 agents · 1 shell"), NOW), true);
});

test("idle with 'N shells still running' status line -> not stopped", () => {
  assert.equal(turnStoppedIdle(ended, live("  PAI CC", "✻ Brewed · done 21:47 · 2 shells still running"), NOW), false);
});

test("idle with done time and no workers in footer -> stopped", () => {
  assert.equal(turnStoppedIdle(ended, live("  🐝 anthropic ▶0 · 0 shells · PAI CC"), NOW), true);
});

test("text in input -> not stopped (live layout)", () => {
  assert.equal(turnStoppedIdle(ended, live("  PAI CC", undefined, "❯ half typed"), NOW), false);
});

test("not stopped: tool pending, just ended, typed input, spinner", () => {
  assert.equal(turnStoppedIdle({ working: true, lastAt: NOW - 60_000 }, pane("x"), NOW), false);
  assert.equal(turnStoppedIdle({ working: false, lastAt: NOW - 5_000 }, pane("x"), NOW), false);
  assert.equal(turnStoppedIdle(ended, pane("x", "❯ half typed"), NOW), false);
  assert.equal(turnStoppedIdle(ended, pane("✻ Proofing… (2m 31s · ↓ 4.2k tokens)"), NOW), false);
});
