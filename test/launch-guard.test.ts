import "./home-guard.js";
/**
 * test/launch-guard.test.ts — a launch must never write into a pane that is
 * already running something (Claude included).
 *
 * Real fault, 2026-09-23: a scheduled dispatch found no live session for
 * "Jobs Alpha" (enumeration had briefly failed) and fell through to
 * launchResolvedPaiProject() -> createClaudeSession(), which landed its
 * `claude --name ... $'/Name ...'` launch command in the project's own
 * already-running Claude pane instead of a fresh shell.
 *
 * openSessionScript() now embeds an `is at shell prompt` guard — the same
 * iTerm primitive isClaudeRunningInSession() uses — inside the single
 * AppleScript call that resolves the target and writes to it, so there is no
 * window between "looks like a fresh tab" and "type into it". These tests
 * drive the JS-side handling of that guard's sentinel; the AppleScript text
 * itself is not executed here (no real iTerm), matching how core.ts is
 * exercised elsewhere in this suite.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { _internal } from "../src/adapters/iterm/core.js";
import { createClaudeSession, createTerminalTab } from "../src/adapters/iterm/sessions.js";

function stubAppleScript(result: string | null) {
  const original = _internal.runItermJxa;
  _internal.runItermJxa = () => result;
  return () => { _internal.runItermJxa = original; };
}

test("createClaudeSession refuses a target that was not at a shell prompt", async () => {
  const restore = stubAppleScript("busy:F5EBF70A-16EC-4F83-AE79-3670AB764C9B");
  try {
    const id = await createClaudeSession("claude --name x");
    assert.equal(id, null, "must not report success for a write it refused to make");
  } finally {
    restore();
  }
});

test("createClaudeSession returns the session id on a genuine fresh tab", async () => {
  const restore = stubAppleScript("F5EBF70A-16EC-4F83-AE79-3670AB764C9B");
  try {
    const id = await createClaudeSession("claude --name x");
    assert.equal(id, "F5EBF70A-16EC-4F83-AE79-3670AB764C9B");
  } finally {
    restore();
  }
});

test("createTerminalTab refuses a busy target the same way", async () => {
  const restore = stubAppleScript("busy:S1");
  try {
    assert.equal(await createTerminalTab("echo hi"), null);
  } finally {
    restore();
  }
});

test("launch script clears the input line before writing the command", async () => {
  const original = _internal.runItermJxa;
  const scripts: string[] = [];
  _internal.runItermJxa = ((s: string) => { scripts.push(s); return "S1"; }) as typeof original;
  try {
    await createTerminalTab("echo hi");
    await createTerminalTab("");
  } finally {
    _internal.runItermJxa = original;
  }
  const withCmd = scripts[0];
  const clear = withCmd.indexOf('session.write({ text: "\\u0015", newline: false });');
  const cmd = withCmd.indexOf('session.write({ text: "echo hi" });');
  assert.ok(clear >= 0 && cmd > clear, "Ctrl-U (no newline) precedes the command");
  assert.ok(!scripts[1].includes("u0015"), "no clear without a command");
});
