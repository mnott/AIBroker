/**
 * test/rename-title-hook.test.ts — pins the fix for the daemon typing
 * `/rename <name>` into the operator's own input line and racing their
 * keyboard. The PreToolUse hook hooks/aibroker-rename-title.mjs writes the
 * /resume picker title straight into the transcript instead.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK = join(import.meta.dirname, "..", "hooks", "aibroker-rename-title.mjs");

function runHook(payload: unknown) {
  return spawnSync("node", [HOOK], { input: JSON.stringify(payload), encoding: "utf-8" });
}

test("positive: appends custom-title line and keeps the earlier line", () => {
  const dir = mkdtempSync(join(tmpdir(), "aibroker-rename-test-"));
  const transcriptPath = join(dir, "transcript.jsonl");
  const existingLine = JSON.stringify({ type: "user", message: { role: "user", content: "hi" } });
  writeFileSync(transcriptPath, existingLine + "\n");

  const result = runHook({
    tool_name: "mcp__aibroker__aibroker_rename",
    tool_input: { name: "  Fresh Name " },
    session_id: "abc",
    transcript_path: transcriptPath,
  });

  assert.equal(result.status, 0);
  const lines = readFileSync(transcriptPath, "utf-8").trim().split("\n");
  assert.equal(lines[0], existingLine);
  assert.equal(lines[1], JSON.stringify({ type: "custom-title", customTitle: "Fresh Name", sessionId: "abc" }));

  rmSync(dir, { recursive: true, force: true });
});

test("negative: unrelated tool name leaves the transcript unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "aibroker-rename-test-"));
  const transcriptPath = join(dir, "transcript.jsonl");
  const existingLine = JSON.stringify({ type: "user", message: { role: "user", content: "hi" } });
  writeFileSync(transcriptPath, existingLine + "\n");

  const result = runHook({
    tool_name: "Task",
    tool_input: { name: "Fresh Name" },
    session_id: "abc",
    transcript_path: transcriptPath,
  });

  assert.equal(result.status, 0);
  assert.equal(readFileSync(transcriptPath, "utf-8"), existingLine + "\n");

  rmSync(dir, { recursive: true, force: true });
});

test("negative: missing transcript file is never created", () => {
  const dir = mkdtempSync(join(tmpdir(), "aibroker-rename-test-"));
  const transcriptPath = join(dir, "missing.jsonl");

  const result = runHook({
    tool_name: "mcp__aibroker__aibroker_rename",
    tool_input: { name: "Fresh Name" },
    session_id: "abc",
    transcript_path: transcriptPath,
  });

  assert.equal(result.status, 0);
  assert.equal(existsSync(transcriptPath), false);

  rmSync(dir, { recursive: true, force: true });
});
