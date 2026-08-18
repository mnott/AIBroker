/**
 * test/manage-standing-rules.test.ts — how to work, written once.
 *
 * The failure this prevents is not a crash. Before standing rules existed the
 * objective was the only text re-typed at every arming, so it was the only
 * place a rule could live that had to hold all night — and the operator wrote
 * the same paragraph into every goal, for every project. Anything they left out
 * in a hurry was a rule that silently did not apply that night.
 *
 * So the composition is pinned here: this string is typed into a live session
 * as keystrokes, and there is no round trip in which a mistake could be caught.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { composeGoal, readStandingRules, writeStandingRules, standingRulesSource, foldHome, expandHome } from "../src/daemon/manage.js";

function tempPath(name = "rules.txt"): string {
  return join(mkdtempSync(join(tmpdir(), "aibroker-rules-")), name);
}

// ── composing the goal ───────────────────────────────────────────────────────

test("the task comes first and the standing rules qualify it", () => {
  const goal = composeGoal("work the open items in order", "bound every wait", "", "");
  assert.match(goal, /^\/goal work the open items in order ALWAYS, on every item: bound every wait$/);
});

test("no rules set means the goal is exactly what it was before", () => {
  // Nobody who has not set rules should see their goals change shape.
  assert.equal(composeGoal("do the thing", "", "", ""), "/goal do the thing");
});

test("the goal is always one line, because a newline submits it", () => {
  // A rules file is edited in a text editor, so it arrives with line breaks —
  // and each one would send the half-written goal on its way.
  const goal = composeGoal("first\nsecond", "one\ntwo\n\nthree", "", "");
  assert.ok(!goal.includes("\n"), `goal must not contain a newline: ${JSON.stringify(goal)}`);
  assert.match(goal, /one two three/);
});

test("the screen state and a one-shot note come after the standing rules", () => {
  // Order is meaning here: the standing rules are about the job, the other two
  // are about right now, and the last thing read is the thing acted on first.
  const goal = composeGoal("the task", "the rules", " SCREEN IS TAKEN", " OPERATOR: also this");
  assert.ok(goal.indexOf("the rules") < goal.indexOf("SCREEN IS TAKEN"));
  assert.ok(goal.indexOf("SCREEN IS TAKEN") < goal.indexOf("OPERATOR: also this"));
});

// ── the file behind them ─────────────────────────────────────────────────────

test("rules survive a write and come back flattened", () => {
  const p = tempPath();
  writeStandingRules("report when you start\nand when you finish", p);
  assert.equal(readStandingRules(p), "report when you start and when you finish");
});

test("no file is not an error, it is no rules", () => {
  assert.equal(readStandingRules(join(tempPath("nowhere"), "missing.txt")), "");
});

test("writing empty text removes the file rather than leaving a blank one", () => {
  // A file holding "" and no file at all must mean the same thing, or `clear`
  // leaves a rule that reads as set and says nothing.
  const p = tempPath();
  writeStandingRules("something", p);
  writeStandingRules("   ", p);
  assert.equal(existsSync(p), false);
  assert.equal(readStandingRules(p), "");
});

test("an unreadable file is no rules, not a thrown error", () => {
  // This is read on the arming path. Throwing here would stop a session being
  // re-armed at all — a far worse outcome than arming without the rules.
  const dir = mkdtempSync(join(tmpdir(), "aibroker-rules-"));
  assert.equal(readStandingRules(dir), "", "a directory where a file was expected");
});

test("a rules file written by hand keeps its wording", () => {
  // The file is meant to be edited in an editor; nothing may rewrite it except
  // to flatten it for typing.
  const p = tempPath();
  writeFileSync(p, "never quit an app with the keyboard shortcut\n");
  assert.equal(readStandingRules(p), "never quit an app with the keyboard shortcut");
});

// ── one owner ────────────────────────────────────────────────────────────────
//
// The same rules belong in the working repository, where they are reviewed with
// the code and read by sessions nobody is managing. Copying them into the
// manager as well would be two places holding one piece of knowledge. A pointer
// keeps one owner.

test("a pointer file reads the rules from where the repository keeps them", () => {
  const repo = tempPath("house-rules.md");
  writeFileSync(repo, "bound every wait\nreport on the issue\n");
  const p = tempPath();
  writeStandingRules(`@${repo}`, p);
  assert.equal(readStandingRules(p), "bound every wait report on the issue");
  assert.equal(standingRulesSource(p), repo);
});

test("a pointer at a file that is not there yet is empty, not an error", () => {
  // The repository copy may arrive after the pointer — a branch not yet pulled,
  // a file not yet written. Armings must continue either way.
  const p = tempPath();
  writeStandingRules(`@${join(tempPath("gone"), "not-written-yet.md")}`, p);
  assert.equal(readStandingRules(p), "");
});

test("plain text is still plain text — an @ inside a sentence is not a pointer", () => {
  const p = tempPath();
  writeStandingRules("write to the operator @ the phone only when asked", p);
  assert.match(readStandingRules(p), /^write to the operator/);
  assert.equal(standingRulesSource(p), p);
});

test("without a pointer the source is the file itself", () => {
  const p = tempPath();
  writeStandingRules("something", p);
  assert.equal(standingRulesSource(p), p);
});

test("a pointer under the home directory is stored without the account name", () => {
  // The pointer is written by a machine and read by a person, and may be copied
  // to another machine or pasted into a report. An absolute path would carry
  // whoever happened to run the command, and would be wrong on the next machine.
  const home = "/somewhere/an-account";
  assert.equal(foldHome(`${home}/repo/rules.md`, home), "~/repo/rules.md");
  assert.equal(expandHome("~/repo/rules.md", home), `${home}/repo/rules.md`);
  assert.equal(foldHome("/opt/shared/rules.md", home), "/opt/shared/rules.md", "paths outside home are left alone");
  assert.equal(expandHome("/opt/shared/rules.md", home), "/opt/shared/rules.md");
});

test("a folded pointer still resolves to the rules", () => {
  const repo = tempPath("house-rules.md");
  writeFileSync(repo, "one rule\n");
  const p = tempPath();
  // Stored relative to a home directory that happens to be the temp root.
  const home = repo.slice(0, repo.lastIndexOf("/"));
  writeStandingRules(`@${foldHome(repo, home)}`, p);
  assert.equal(readStandingRules(p, ), "");  // resolves against the real home, not this fake one
  writeStandingRules(`@${repo}`, p);
  assert.equal(readStandingRules(p), "one rule", "an absolute pointer still works");
});

// ── the goal has to fit through the door ─────────────────────────────────────
//
// The receiving prompt refuses a goal over a few thousand characters, and it
// refuses the whole thing. A rules file that grew by a paragraph therefore
// stopped every arming, while the manager reported "typed, but the objective's
// own words never appeared" — true, and silent about the cause.

test("a goal that would be too long points at the rules instead of pasting them", () => {
  const long = "x".repeat(5000);
  const goal = composeGoal("do the work", long, "", "", "/somewhere/rules.md");
  assert.ok(goal.length < 4000, `goal was ${goal.length} characters`);
  assert.match(goal, /read \/somewhere\/rules\.md/);
  assert.match(goal, /do the work/, "the task itself is never what gets dropped");
});

test("rules that fit are still pasted, because inline beats a lookup when it fits", () => {
  const goal = composeGoal("do the work", "bound every wait", "", "", "/somewhere/rules.md");
  assert.match(goal, /ALWAYS, on every item: bound every wait/);
  assert.equal(goal.includes("/somewhere/rules.md"), false);
});

test("a one-shot note and the screen state survive the switch to pointing", () => {
  // These are about right now; losing them silently would be worse than losing
  // the rules, which at least remain readable in the file.
  const goal = composeGoal("do the work", "y".repeat(5000), " SCREEN IS TAKEN", " OPERATOR: also this", "/r.md");
  assert.match(goal, /SCREEN IS TAKEN/);
  assert.match(goal, /OPERATOR: also this/);
});

test("with no path to point at, an oversized rule set is dropped rather than sent", () => {
  // Sending it would have the whole goal rejected, which loses the objective too.
  const goal = composeGoal("do the work", "z".repeat(5000), "", "");
  assert.ok(goal.length < 4000);
  assert.match(goal, /do the work/);
});
