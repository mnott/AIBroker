import "./home-guard.js";
/**
 * A goal session is never idle, so the typed handover ask never fired and the
 * session compacted at 931k with nothing written. The ask is now a marker the
 * handover-due hook delivers once; the trigger comes from the project's
 * lowest measured compaction.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handoverDue, measuredCompactForProject, writeHandoverMarker, handoverMarkerPath } from "../src/daemon/manage.js";

const HOOK = join(import.meta.dirname, "..", "hooks", "handover-due.mjs");

test("band due while busy: typed decision holds off, ungated decision is due", () => {
  const base = { contextK: 925, effectiveK: 931, handoverDoneK: undefined, lastAskAt: undefined, now: Date.now() };
  assert.equal(handoverDue({ ...base, idleMs: 0 }).due, false);
  assert.equal(handoverDue({ ...base, idleMs: Number.MAX_SAFE_INTEGER }).due, true);
});

test("hook returns the marker as additionalContext once, then nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "hdue-"));
  process.env.AIBROKER_HANDOVER_DIR = dir;
  writeHandoverMarker("SESS-1", { contextK: 925, triggerK: 931, target: "Notes/TODO.md", path: null, askedAt: 1 });
  const run = () =>
    spawnSync("node", [HOOK], {
      env: { ...process.env, AIBROKER_HANDOVER_DIR: dir, ITERM_SESSION_ID: "w0t0p0:SESS-1", PAI_WORKER: "" },
      input: JSON.stringify({ hook_event_name: "PostToolUse" }),
      encoding: "utf8",
      timeout: 5000,
    });
  const first = run();
  const out = JSON.parse(first.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(out.hookSpecificOutput.additionalContext, /Context at 925k of ~931k: update your handover now \(Notes\/TODO\.md\)/);
  assert.equal(existsSync(handoverMarkerPath("SESS-1")), false);
  assert.equal(run().stdout.trim(), "");
});

test("hook ignores another session's marker", () => {
  const dir = mkdtempSync(join(tmpdir(), "hdue-"));
  process.env.AIBROKER_HANDOVER_DIR = dir;
  writeHandoverMarker("OTHER", { contextK: 1, triggerK: 2, target: "x", path: null, askedAt: 1 });
  const r = spawnSync("node", [HOOK], {
    env: { ...process.env, AIBROKER_HANDOVER_DIR: dir, ITERM_SESSION_ID: "w0t0p0:MINE", PAI_WORKER: "" },
    input: "{}", encoding: "utf8", timeout: 5000,
  });
  assert.equal(r.stdout.trim(), "");
  assert.equal(existsSync(handoverMarkerPath("OTHER")), true);
});

test("trigger estimate takes the project minimum over other sessions' transcripts", () => {
  const dir = mkdtempSync(join(tmpdir(), "proj-"));
  const ev = (pre: number, at: string) =>
    JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp: at, compactMetadata: { trigger: "auto", preTokens: pre } }) + "\n";
  writeFileSync(join(dir, "a.jsonl"), ev(931_356, "2026-11-23T10:00:00Z"));
  writeFileSync(join(dir, "b.jsonl"), ev(905_000, "2026-11-20T10:00:00Z"));
  writeFileSync(join(dir, "mine.jsonl"), "{}\n");
  assert.equal(measuredCompactForProject(join(dir, "mine.jsonl"))?.k, 905);
});
