import "./home-guard.js";
/**
 * test/agentish-expand.test.ts — `expand()`, AG2's decompress half.
 *
 * `check()` already parses `@n=path` declarations and validates `@n` refs
 * inside `chg` (see test/agentish.test.ts). `expand()` is the missing other
 * direction: given a compact message, resolve every reference back to the
 * path its declaration named, so a compressed message round-trips to a
 * readable one. These tests exist so a refactor that quietly breaks that
 * round-trip — or quietly changes `check()`'s own behavior along the way —
 * gets caught instead of shipped.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { check, expand } from "../src/agentish/index.js";
import { runAgentish } from "../src/daemon/agentish-cli.js";

function tempFile(name: string, content: string): string {
  const p = join(mkdtempSync(join(tmpdir(), "agentish-expand-test-")), name);
  writeFileSync(p, content);
  return p;
}

// ── expand(): the basics ─────────────────────────────────────────────────────

test("expand-single-ref+ a single @n:line ref resolves to its declared path", () => {
  const msg = [
    "R", "i=x",
    "@a=Sources/Mac/Window/DocumentWindowController/DocumentWindowController+Tools.swift",
    "c=@a:220 blackoutTag",
    "res=~", "test=Only+", "gate=~", "y=partial",
  ].join("\n");
  const { expanded, errors } = expand(msg);
  assert.deepEqual(errors, []);
  assert.ok(
    expanded.includes(
      "c=Sources/Mac/Window/DocumentWindowController/DocumentWindowController+Tools.swift:220 blackoutTag",
    ),
  );
  assert.ok(!expanded.includes("@a="), "declaration line must be dropped, not reprinted");
  assert.ok(!/(?<!\w)@a(?!\w)/.test(expanded), "no bare @a reference should survive expansion");
});

test("expand-multi-ref-one-line+ several refs to the same symbol on one line all expand", () => {
  const msg = [
    "R", "i=x",
    "@a=Sources/Mac/Window/DocumentWindowController/DocumentWindowController+Tools.swift",
    "c=@a:220 blackoutTag | @a:296 blackoutToggleIsArmed",
    "res=~", "test=Only+", "gate=~", "y=partial",
  ].join("\n");
  const { expanded } = expand(msg);
  const path = "Sources/Mac/Window/DocumentWindowController/DocumentWindowController+Tools.swift";
  assert.ok(expanded.includes(`c=${path}:220 blackoutTag | ${path}:296 blackoutToggleIsArmed`));
});

test("expand-multi-symbol+ two declared symbols across fields both resolve", () => {
  const msg = [
    "R", "i=x",
    "@a=src/agentish/index.ts",
    "@b=src/daemon/agentish-cli.ts",
    "c=@a:100 added expand | @b:60 added verb",
    "res=~", "test=Only+", "gate=~", "y=partial",
  ].join("\n");
  const { expanded, symbols, errors } = expand(msg);
  assert.deepEqual(errors, []);
  assert.deepEqual(symbols, { a: "src/agentish/index.ts", b: "src/daemon/agentish-cli.ts" });
  assert.ok(expanded.includes("c=src/agentish/index.ts:100 added expand | src/daemon/agentish-cli.ts:60 added verb"));
});

// ── symbol reuse from earlier messages ───────────────────────────────────────

test("expand-ref-from-earlier+ a symbol declared in an earlier thread message expands here", () => {
  const earlier = ["T", "i=x", "g=g", "d=d", "t=Only+", "@1=/repo/src/a.ts"].join("\n");
  const reply = ["R", "i=x", "res=~", "chg=@1:10 changed the thing", "test=Only+", "gate=~", "y=partial"].join("\n");
  const { expanded, symbols, errors } = expand(reply, [earlier]);
  assert.deepEqual(errors, []);
  assert.equal(symbols["1"], "/repo/src/a.ts");
  assert.ok(expanded.includes("chg=/repo/src/a.ts:10 changed the thing"));
  assert.ok(!/(?<!\w)@1(?!\w)/.test(expanded));
});

// ── dangling refs ────────────────────────────────────────────────────────────

test("expand-dangling-ref- an undeclared symbol is left verbatim and reported", () => {
  const msg = ["R", "i=x", "chg=@z:5 nobody declared z", "res=~", "test=Only+", "gate=~", "y=w"].join("\n");
  const { expanded, errors, details } = expand(msg);
  assert.ok(expanded.includes("chg=@z:5 nobody declared z"), "dangling ref stays verbatim in best-effort output");
  assert.ok(errors.length > 0);
  assert.ok(details.some((d) => d.code === "E_REF_UNDECLARED" && d.message.includes("@z")));
});

test("expand-mixed-dangling-and-resolved+ a declared ref resolves while an undeclared one is flagged", () => {
  const msg = [
    "R", "i=x", "@a=src/a.ts",
    "chg=@a:1 known | @z:2 unknown",
    "res=~", "test=Only+", "gate=~", "y=w",
  ].join("\n");
  const { expanded, errors } = expand(msg);
  assert.ok(expanded.includes("chg=src/a.ts:1 known | @z:2 unknown"));
  assert.ok(errors.some((e) => e.includes("@z")));
});

// ── round-trip sanity ────────────────────────────────────────────────────────

test("expand-round-trip+ output has no declaration lines and no leftover declared-symbol tokens", () => {
  const msg = [
    "T", "i=fix-flaky-retry", "g=stop the test flaking under load",
    "@1=/repo/src/net/retry.ts",
    "o=@1",
    "d=read @1, reproduce, fix, add a test",
    "p=paste the failing run then the fixed run",
    "t=Retry+",
  ].join("\n");
  const { expanded, errors } = expand(msg);
  assert.deepEqual(errors, []);
  assert.ok(!expanded.includes("@1="), "no declaration line should remain");
  assert.ok(!/(?<!\w)@1(?!\w)/.test(expanded), "no bare @1 token should remain");
  assert.ok(expanded.includes("o=/repo/src/net/retry.ts"));
  assert.ok(expanded.includes("d=read /repo/src/net/retry.ts, reproduce, fix, add a test"));
});

// ── id and kind lines are never touched ──────────────────────────────────────

test("expand-leaves-id-and-kind-alone+ a symbol-shaped id and the kind line pass through untouched", () => {
  const msg = ["R", "i=x", "@a=src/a.ts", "res=~", "test=Only+", "gate=~", "y=w"].join("\n");
  const { expanded } = expand(msg);
  const outLines = expanded.split("\n");
  assert.equal(outLines[0], "R");
  assert.equal(outLines[1], "i=x");
});

// ── check() is unchanged by the refactor ─────────────────────────────────────

test("check-unchanged-after-refactor+ check() still validates a well-formed T with no errors", () => {
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

test("check-unchanged-after-refactor+ check() still rejects an undeclared @ ref in chg", () => {
  const msg = [
    "R", "i=x", "res=~", "chg=@9:12 touched a file nobody declared", "test=Only+", "gate=~",
    "y=symbol was never declared",
  ].join("\n");
  const { errors } = check(msg);
  assert.ok(errors.some((e) => e.includes("undeclared symbol @9")));
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

test("cli-expand-exit-0-on-resolved+ `agentish expand` exits 0 and prints the expanded message", async () => {
  const good = tempFile(
    "good.txt",
    ["R", "i=x", "@a=src/a.ts", "c=@a:220 blackoutTag", "res=~", "test=Only+", "gate=~", "y=w"].join("\n"),
  );
  const { lines, exitCode } = await captureLogs(() => runAgentish(["expand", good]));
  assert.equal(exitCode, 0);
  assert.ok(lines.some((l) => l.includes("c=src/a.ts:220 blackoutTag")));
  assert.ok(!lines.some((l) => l.includes("@a=")));
});

test("cli-expand-exit-1-on-dangling+ `agentish expand` exits 1 on a dangling ref", async () => {
  const bad = tempFile("bad.txt", ["R", "i=x", "chg=@z:5 x", "res=~", "test=Only+", "gate=~", "y=w"].join("\n"));
  const { lines, exitCode } = await captureLogs(() => runAgentish(["expand", bad]));
  assert.equal(exitCode, 1);
  assert.ok(lines.some((l) => l.startsWith("ERR") && l.includes("@z")));
});

test("cli-expand-json+ `expand --json` carries expanded, symbols, coded errors and ok", async () => {
  const good = tempFile("good2.txt", ["R", "i=x", "@a=src/a.ts", "c=@a:1 x", "res=~", "test=Only+", "gate=~", "y=w"].join("\n"));
  const { lines } = await captureLogs(() => runAgentish(["expand", good, "--json"]));
  const parsed = JSON.parse(lines.join("\n"));
  assert.equal(parsed.version, "2");
  assert.ok(parsed.expanded.includes("c=src/a.ts:1 x"));
  assert.deepEqual(parsed.symbols, { a: "src/a.ts" });
  assert.equal(parsed.ok, true);
});

test("cli-expand-exit-2-on-missing-file+ a file that cannot be read exits 2, not 1", async () => {
  const missing = join(mkdtempSync(join(tmpdir(), "agentish-expand-test-")), "does-not-exist.txt");
  const { exitCode, lines } = await captureLogs(() => runAgentish(["expand", missing]));
  assert.equal(exitCode, 2);
  assert.ok(lines.some((l) => l.startsWith("ERR")));
});
