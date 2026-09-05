/**
 * test/agentish.test.ts — AG2 validator and CLI.
 *
 * The validator is a port of a sibling project's Python tool, plus this
 * project's own additions (proof gating, the T→R test-set cross-check, the
 * `why` extension). These tests exist because a port — or an addition — that
 * silently drops a rule is worse than none: it looks checked and is not. See
 * docs/agentish.md.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AG2_SPEC, AG2_EXTENSIONS, check, measure } from "../src/agentish/index.js";
import { runAgentish } from "../src/daemon/agentish-cli.js";
import { composeGoal } from "../src/daemon/manage.js";

function tempFile(name: string, content: string): string {
  const p = join(mkdtempSync(join(tmpdir(), "agentish-test-")), name);
  writeFileSync(p, content);
  return p;
}

// ── check(): required fields and unknown fields ─────────────────────────────

test("check-valid-T+ a well-formed task has no errors", () => {
  const msg = [
    "T",
    "i=fix-flaky-retry",
    "g=stop the test flaking under load",
    "o=@1=/repo/src/net/retry.ts",
    "d=read @1, reproduce, fix, add a test",
    "p=paste the failing run then the fixed run",
    "u=R with c=@1:lines t=Retry+ G=+/-",
    "t=Retry+",
  ].join("\n");
  const { kind, errors } = check(msg);
  assert.equal(kind, "T");
  assert.deepEqual(errors, []);
});

test("check-valid-R+ a well-formed report has no errors", () => {
  const msg = [
    "R",
    "i=fix-flaky-retry",
    "@1=/repo/src/net/retry.ts",
    "res=+",
    "chg=@1:88 widened the backoff window",
    "test=Retry+ Regression+",
    "gate=+",
    "p=pasted the passing run",
  ].join("\n");
  const { kind, errors } = check(msg);
  assert.equal(kind, "R");
  assert.deepEqual(errors, []);
});

test("check-unknown-kind- a kind outside T R S Q A X is rejected", () => {
  const { errors } = check("Z\ni=x");
  assert.ok(errors.some((e) => e.includes("unknown kind")));
});

test("check-unknown-key- a key the kind does not declare is rejected", () => {
  const msg = ["A", "i=x", "res=+", "a=yes", "bogus=nope"].join("\n");
  const { errors } = check(msg);
  assert.ok(errors.some((e) => e.includes("unknown key bogus")));
});

test("check-T-missing-required-key- a T missing one of i g d t is rejected by letter", () => {
  const msg = ["T", "i=x", "g=goal", "d=do"].join("\n"); // no t=
  const { errors } = check(msg);
  assert.ok(errors.includes("T requires t"));
});

test("check-Q-without-z- a Q missing its note is rejected", () => {
  const msg = ["Q", "i=x", "q=which approach?", "dflt=A"].join("\n"); // no z=
  const { errors } = check(msg);
  assert.ok(errors.includes("Q requires z"));
});

// ── value shapes ─────────────────────────────────────────────────────────────

test("check-i-bad-shape- an id that does not start lower-case alphanumeric is rejected", () => {
  const msg = ["A", "i=Bad_ID!", "res=+", "a=yes"].join("\n");
  const { errors } = check(msg);
  assert.ok(errors.includes("i: bad shape"));
});

test("check-bad-outcome- res outside + - ~ ? ! is rejected", () => {
  const msg = ["S", "i=x", "res=maybe"].join("\n");
  const { errors } = check(msg);
  assert.ok(errors.includes("r: bad shape"));
});

test("check-tests-token-shape- every space-separated test entry must end in an outcome", () => {
  const msg = [
    "R", "i=x", "res=~", "chg=src/a.ts touched", "test=One+ TwoNoOutcome", "gate=~",
    "y=one token was missing its outcome marker",
  ].join("\n");
  const { errors } = check(msg);
  assert.ok(errors.includes("test: every entry ends with + - ~ ?"));
});

test("check-c-item-without-ref- a chg entry with neither an @ref nor a path is rejected", () => {
  const msg = ["R", "i=x", "res=~", "chg=fixed the bug", "test=One+", "gate=~", "y=no file named"].join("\n");
  const { errors } = check(msg);
  assert.ok(errors.includes("c: bad shape"));
});

// ── @n symbols ───────────────────────────────────────────────────────────────

test("check-undeclared-at-ref- a chg entry naming an undeclared symbol is rejected", () => {
  const msg = [
    "R", "i=x", "res=~", "chg=@9:12 touched a file nobody declared", "test=Only+", "gate=~",
    "y=symbol was never declared",
  ].join("\n");
  const { errors } = check(msg);
  assert.ok(errors.some((e) => e.includes("undeclared symbol @9")));
});

test("check-at-ref-declared-in-earlier+ a symbol declared in an earlier message in the thread is in scope", () => {
  const earlier = ["T", "i=x", "g=g", "d=d", "t=Only+", "@1=/repo/src/a.ts"].join("\n");
  const reply = ["R", "i=x", "res=~", "chg=@1:10 changed the thing", "test=Only+", "gate=~", "y=partial"].join("\n");
  const { errors } = check(reply, [earlier]);
  assert.deepEqual(errors, []);
});

test("check-at-ref-file-line-after-declare+ the @n:line form resolves to the declared symbol", () => {
  const msg = [
    "R", "i=x", "@1=/repo/src/a.ts", "res=~", "chg=@1:42 renamed a field", "test=Only+", "gate=~",
    "y=partial",
  ].join("\n");
  const { errors } = check(msg);
  assert.deepEqual(errors, []);
});

// ── the T ↔ R test-set cross-check ───────────────────────────────────────────

test("check-R-omits-T-test- an R silent about a test its T asked for is rejected", () => {
  const earlier = ["T", "i=x", "g=g", "d=d", "t=Alpha+ Beta+"].join("\n");
  const reply = ["R", "i=x", "res=~", "chg=src/a.ts touched", "test=Alpha+", "gate=~", "y=beta pending"].join("\n");
  const { errors } = check(reply, [earlier]);
  assert.ok(errors.includes("t omitted: Beta"));
});

test("check-R-adds-unrequested-test- an R naming a test its T never asked for is rejected", () => {
  const earlier = ["T", "i=x", "g=g", "d=d", "t=Alpha+ Beta+"].join("\n");
  const reply = ["R", "i=x", "res=~", "chg=src/a.ts touched", "test=Alpha+ Beta+ Gamma+", "gate=~", "y=extra check added"]
    .join("\n");
  const { errors } = check(reply, [earlier]);
  assert.ok(errors.includes("t unrequested: Gamma"));
});

test("check-R-matches-T-tests+ an R naming exactly its T's tests is accepted regardless of outcome", () => {
  const earlier = ["T", "i=x", "g=g", "d=d", "t=Alpha+ Beta+"].join("\n");
  const reply = ["R", "i=x", "res=~", "chg=src/a.ts touched", "test=Alpha+ Beta-", "gate=~", "y=beta failed, is worst"]
    .join("\n");
  const { errors } = check(reply, [earlier]);
  assert.deepEqual(errors, []);
});

// ── proof gating ─────────────────────────────────────────────────────────────

test("check-R-r-plus-without-p- res=+ without a non-empty prove field is rejected", () => {
  const msg = ["R", "i=x", "res=+", "chg=src/a.ts touched", "test=One+", "gate=+"].join("\n"); // no p=
  const { errors } = check(msg);
  assert.ok(errors.includes("r=+ without proof"));
});

test("check-R-r-plus-without-G- res=+ without gate=+ is rejected", () => {
  const msg = ["R", "i=x", "res=+", "chg=src/a.ts touched", "test=One+", "p=proof pasted"].join("\n"); // no G=
  const { errors } = check(msg);
  assert.ok(errors.includes("r=+ without proof"));
});

test("check-r-plus-with-failing-t- res=+ is rejected when a test entry failed", () => {
  const msg = ["R", "i=x", "res=+", "chg=src/a.ts touched", "test=One+ Two-", "gate=+", "p=proof pasted"].join("\n");
  const { errors } = check(msg);
  assert.ok(errors.includes("r=+ without proof"));
});

test("check-r-plus-all-t-plus+ res=+ is accepted when gate, proof and every test all agree", () => {
  const msg = ["R", "i=x", "res=+", "chg=src/a.ts touched", "test=One+ Two+", "gate=+", "p=proof pasted"].join("\n");
  const { errors } = check(msg);
  assert.deepEqual(errors, []);
});

test("check-R-r-minus-without-y- res=- without a why is rejected", () => {
  const msg = ["R", "i=x", "res=-", "chg=src/a.ts touched", "test=One-", "gate=-"].join("\n"); // no y=
  const { errors } = check(msg);
  assert.ok(errors.includes("R requires y"));
});

// ── note and the why extension ───────────────────────────────────────────────

test("check-z-over-200- a note past 200 characters is rejected as restating the task", () => {
  const msg = ["A", "i=x", "res=+", "a=yes", `z=${"x".repeat(201)}`].join("\n");
  const { errors } = check(msg);
  assert.ok(errors.some((e) => e.includes("200")));
});

test("check-y-over-600- a why past 600 characters is rejected", () => {
  const msg = ["X", "i=x", "z=short note", `y=${"x".repeat(601)}`].join("\n");
  const { errors } = check(msg);
  assert.ok(errors.some((e) => e.includes("600")));
});

test("check-y-in-T- a T carrying why is rejected — the extension is not accepted there", () => {
  const msg = ["T", "i=x", "g=goal", "d=do", "t=Test+", "y=explanation"].join("\n");
  const { errors } = check(msg);
  assert.ok(errors.includes("unknown key why"));
});

// ── measure(): the cost claim is a number ────────────────────────────────────

test("measure reports a smaller agentish count than its prose twin", () => {
  const agentish = ["R", "i=x", "res=+", "chg=src/a.ts touched", "test=One+", "gate=+", "p=proof pasted"].join("\n");
  const prose =
    "I believe I have now finished the task you asked me to do. As far as I can tell, I did not change " +
    "anything that seemed important along the way. The one test I ran seemed to pass, and as far as I " +
    "could tell the overall gate command also passed, so I think this should be good to go.";
  const { agentish: a, prose: p, ratio, valid } = measure(agentish, prose);
  assert.ok(a < p, `expected agentish (${a}) < prose (${p})`);
  assert.ok(ratio < 1);
  assert.equal(valid, true);
});

// ── the arming contract: AG2 goes to sessions, prose to everyone else ────────

test("arming-text-starts-with-AG2-spec+ the goal text composed for a managed session leads with AG2_SPEC", () => {
  // This is the same composition manage.ts's goalText() performs: AG2_SPEC is
  // folded into composeGoal's objective argument so it lands ahead of both
  // the task and the standing rules, without changing what composeGoal itself
  // does with the objective it is given (that shape is pinned in
  // test/manage-standing-rules.test.ts and must not move here).
  const goal = composeGoal(`${AG2_SPEC} do the work`, "bound every wait", "", "");
  assert.ok(goal.startsWith(`/goal ${AG2_SPEC}`), "AG2_SPEC must be the first thing after /goal");
  assert.ok(goal.indexOf(AG2_SPEC) < goal.indexOf("do the work"));
  assert.ok(goal.indexOf("do the work") < goal.indexOf("bound every wait"));
});

// ── CLI ──────────────────────────────────────────────────────────────────────

async function captureLogs(fn: () => Promise<void>): Promise<{ lines: string[]; exitCode: number | string | undefined }> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  const originalExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await fn();
    return { lines, exitCode: process.exitCode };
  } finally {
    console.log = original;
    process.exitCode = originalExitCode;
  }
}

test("cli-spec-prints-verbatim+ `agentish spec` prints AG2_SPEC as its first line, verbatim", async () => {
  const { lines, exitCode } = await captureLogs(() => runAgentish(["spec"]));
  assert.equal(lines[0], AG2_SPEC);
  assert.equal(exitCode, undefined);
});

test("spec-prints-extensions+ `agentish spec` also prints the AG2.1 extensions line", async () => {
  const { lines } = await captureLogs(() => runAgentish(["spec"]));
  assert.equal(lines[1], AG2_EXTENSIONS);
});

test("spec-json-has-uri+ `spec --json` carries spec, extensions and a resolvable uri", async () => {
  const { lines } = await captureLogs(() => runAgentish(["spec", "--json"]));
  const parsed = JSON.parse(lines.join("\n"));
  assert.equal(parsed.spec, AG2_SPEC);
  assert.equal(parsed.extensions, AG2_EXTENSIONS);
  assert.match(parsed.uri, /^urn:/);
});

test("cli-check-exit-1-on-error+ `agentish check` exits 1 on an invalid message and 0 on a valid one", async () => {
  const bad = tempFile("bad.txt", "Z\ni=x");
  const badRun = await captureLogs(() => runAgentish(["check", bad]));
  assert.equal(badRun.exitCode, 1);
  assert.ok(badRun.lines.some((l) => l.startsWith("ERR")));

  const good = tempFile("good.txt", ["A", "i=x", "res=+", "a=yes"].join("\n"));
  const goodRun = await captureLogs(() => runAgentish(["check", good]));
  assert.equal(goodRun.exitCode, 0);
  assert.ok(goodRun.lines.some((l) => l.endsWith(" ok")));
});

test("check-exit-1-on-error+ exit codes distinguish invalid content (1) from a bad invocation (2)", async () => {
  const bad = tempFile("bad2.txt", "Z\ni=x");
  const { exitCode } = await captureLogs(() => runAgentish(["check", bad]));
  assert.equal(exitCode, 1);
});

test("check-exit-2-on-missing-file+ a file that cannot be read exits 2, not 1", async () => {
  const missing = join(mkdtempSync(join(tmpdir(), "agentish-test-")), "does-not-exist.txt");
  const { exitCode, lines } = await captureLogs(() => runAgentish(["check", missing]));
  assert.equal(exitCode, 2);
  assert.ok(lines.some((l) => l.startsWith("ERR")));
});

test("check-json-shape+ `check --json` prints version, kind, fields, coded errors and ok", async () => {
  const bad = tempFile("bad3.txt", ["A", "i=x"].join("\n")); // missing required res
  const { lines } = await captureLogs(() => runAgentish(["check", bad, "--json"]));
  const parsed = JSON.parse(lines.join("\n"));
  assert.equal(parsed.version, "2");
  assert.equal(parsed.kind, "A");
  assert.equal(parsed.ok, false);
  assert.ok(Array.isArray(parsed.errors) && parsed.errors.length > 0);
  assert.ok(parsed.errors.every((e: { code: string; message: string }) => typeof e.code === "string" && typeof e.message === "string"));
  assert.ok(parsed.errors.some((e: { code: string }) => e.code === "E_REQUIRED"));
});

test("error-codes-stable+ each check documented above maps to the code docs/agentish.md promises", () => {
  const cases: Array<[string, string]> = [
    ["Z\ni=x", "E_KIND"],
    [["T", "i=x", "g=g", "d=d"].join("\n"), "E_REQUIRED"], // missing t
    [["A", "i=x", "res=+", "bogus=1"].join("\n"), "E_KEY"],
    [["A", "i=Bad!", "res=+", "a=1"].join("\n"), "E_SHAPE"],
    [["R", "i=x", "res=~", "chg=@9:1 x", "test=One+", "gate=~", "y=w"].join("\n"), "E_REF_UNDECLARED"],
    [["R", "i=x", "res=+", "chg=src/a.ts x", "test=One+", "gate=+"].join("\n"), "E_R_UNPROVEN"], // no p=
    [["R", "i=x", "res=-", "chg=src/a.ts x", "test=One-", "gate=-"].join("\n"), "E_REQUIRED"], // no y=
    [["A", "i=x", "res=+", "a=1", `z=${"x".repeat(201)}`].join("\n"), "E_Z_LEN"],
    [["X", "i=x", "z=n", `y=${"x".repeat(601)}`].join("\n"), "E_Y_LEN"],
  ];
  for (const [msg, code] of cases) {
    const { details } = check(msg);
    assert.ok(details.some((d) => d.code === code), `expected ${code} for: ${msg.split("\n")[0]}`);
  }
});
