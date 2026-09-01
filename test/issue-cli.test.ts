/**
 * test/issue-cli.test.ts — the shell entry, and the one way it could go wrong.
 *
 * `aibroker issue` exists because a newly published MCP tool does not appear in
 * an already-running session, and making it appear needs a person. A session
 * with a finding ready to post and no way to post it is the case this removes.
 *
 * The temptation, when writing it, is to call the forge from the CLI process
 * directly — it is shorter and it appears to work. It would break two things
 * that leave no trace when broken: the permission check lives in the daemon,
 * and so does the record of what was just written, which is what stops a
 * session being handed its own comment as news. A CLI that reached the forge
 * itself would bypass the first and be invisible to the second.
 *
 * So this asserts the shape rather than the behaviour, and says plainly that it
 * cannot see the property defeated through a helper it does not recognise.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/daemon/issue-cli.ts", import.meta.url), "utf8");
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("the CLI asks the daemon; it does not talk to the forge itself", () => {
  assert.match(code, /call_raw\("issue"/, "must go through the daemon's issue handler");
  assert.doesNotMatch(code, /\bfetch\s*\(/, "a direct forge call would bypass permission and echo suppression");
  assert.doesNotMatch(code, /issueOp/, "same reason: the daemon owns the write, not this process");
});

test("no flag can claim to be another session", () => {
  // Identity comes from the environment the shell was launched in, which the
  // IPC client reads for itself. A --session or --as flag here would hand a
  // caller the one thing the whole permission model refuses to let it choose.
  //
  // Checked by reading the option names the file actually accepts, not by
  // searching for the string "--session": a first version of this test looked
  // for the spelling and a mutation adding `flag("session")` walked straight
  // past it, since the dashes are added inside the helper.
  const accepted = [...code.matchAll(/\b(?:flag|num)\("([^"]+)"\)/g)].map((m) => m[1]);
  assert.ok(accepted.length > 0, "no options found — this check has gone stale");
  const allowed = new Set(["issue", "comment", "body", "title", "label", "state", "count"]);
  for (const name of accepted) {
    assert.ok(allowed.has(name), `"${name}" is not a permitted option — identity must not be selectable`);
  }
  assert.doesNotMatch(code, /ITERM_SESSION_ID/, "not even by setting it explicitly here");
});

test("the command is actually wired into the CLI", () => {
  const cli = readFileSync(new URL("../src/daemon/cli.ts", import.meta.url), "utf8");
  assert.match(cli, /case "issue":/, "an unreachable subcommand is the fault this file exists to prevent");
  assert.match(cli, /runIssue\(rest\)/);
});

test("long bodies can arrive on stdin, because shell quoting mangles findings", () => {
  // A finding worth posting carries newlines, quotes and a cited error string.
  assert.match(code, /body === "-"/);
  assert.match(code, /readStdin/);
});

test("an unreachable daemon reads differently from a refusal", () => {
  // "not allowed" and "nothing was asked" are opposite answers and must not
  // look alike to somebody reading a terminal at speed.
  assert.match(code, /Is it running\?/);
});
