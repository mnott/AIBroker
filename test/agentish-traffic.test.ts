import "./home-guard.js";
/**
 * test/agentish-traffic.test.ts — the AG2 validator pinned to recorded real
 * inter-agent traffic (sanitised; see test/fixtures/agentish-traffic). The
 * expectations are what the validator returned when the corpus was recorded
 * and reviewed; a change in check() that moves any of them must be deliberate.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { check } from "../src/agentish/index.js";
import { runAgentishCli } from "../src/agentish/cli.js";

const here = dirname(fileURLToPath(import.meta.url));
const fx = join(here, "fixtures", "agentish-traffic");
interface Rec { id: string; msg: string; expectOk: boolean; expectCodes: string[] }
const load = (f: string): Rec[] => JSON.parse(readFileSync(join(fx, f), "utf8"));
const valid = load("valid.jsonl");
const invalid = load("invalid.jsonl");
const codesOf = (m: string, earlier: string[] = []) =>
  [...new Set(check(m, earlier).details.map((d) => d.code))].sort();

test("fixtures are non-trivial and sanitised", () => {
  assert.ok(valid.length >= 10 && invalid.length >= 30);
  for (const r of [...valid, ...invalid]) {
    assert.ok(!/\/Users\//.test(r.msg), r.id);
    assert.ok(!/[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(r.msg), r.id);
  }
});

test("valid real messages stay valid", () => {
  for (const r of valid) {
    assert.equal(r.expectOk, true, r.id);
    assert.deepEqual(codesOf(r.msg), [], r.id);
  }
});

test("invalid real messages keep exactly the recorded codes", () => {
  for (const r of invalid) {
    assert.equal(r.expectOk, false, r.id);
    assert.deepEqual(codesOf(r.msg), r.expectCodes, r.id);
  }
});

test("every recorded error code occurs, incl. R claiming r=+ without proof", () => {
  const seen = new Set(invalid.flatMap((r) => r.expectCodes));
  for (const c of ["E_KEY", "E_REQUIRED", "E_SHAPE", "E_DUP", "E_Z_LEN", "E_R_UNPROVEN"]) assert.ok(seen.has(c), c);
  const unproven = invalid.filter((r) => r.msg.startsWith("R\n") && /^r=\+$/m.test(r.msg) && r.expectCodes.includes("E_R_UNPROVEN"));
  assert.ok(unproven.length > 0);
});

test("T then R chains validate to the recorded codes", () => {
  const chains: { id: string; msgs: string[]; expectCodes: string[] }[] = JSON.parse(readFileSync(join(fx, "chains.json"), "utf8"));
  assert.ok(chains.length > 0);
  for (const c of chains) {
    assert.deepEqual(check(c.msgs[1], [c.msgs[0]]).details.map((d) => d.code), c.expectCodes, c.id);
  }
});

// Run the standalone CLI in-process: capture console.log and process.exitCode.
async function cli(args: string[]) {
  const out: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  process.exitCode = undefined;
  try {
    await runAgentishCli(args);
    return { code: Number(process.exitCode ?? 0), out: out.join("\n") };
  } finally {
    console.log = log;
    process.exitCode = undefined;
  }
}

test("standalone CLI check-log: exit 0 on valid corpus, 1 on invalid, JSON summary", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentish-traffic-"));
  const jl = (rs: Rec[]) => rs.map((r) => JSON.stringify({ body: r.msg })).join("\n") + "\n";
  const v = join(dir, "valid.jsonl");
  const i = join(dir, "invalid.jsonl");
  writeFileSync(v, jl(valid));
  writeFileSync(i, jl(invalid));

  const rv = await cli(["check-log", v, "--json"]);
  assert.equal(rv.code, 0, rv.out);
  const sv = JSON.parse(rv.out);
  assert.deepEqual(sv.summary, { total: valid.length, valid: valid.length, invalid: 0, codes: {} });

  const ri = await cli(["check-log", i, "--json"]);
  assert.equal(ri.code, 1, ri.out);
  const si = JSON.parse(ri.out);
  assert.equal(si.summary.total, invalid.length);
  assert.equal(si.summary.invalid, invalid.length);
  assert.ok(si.summary.codes.E_R_UNPROVEN > 0);

  // blank-line separated form
  const blank = join(dir, "blank.txt");
  writeFileSync(blank, valid.slice(0, 3).map((r) => r.msg).join("\n\n") + "\n");
  const rb = await cli(["check-log", blank, "--json"]);
  assert.equal(rb.code, 0);
  assert.equal(JSON.parse(rb.out).summary.total, 3);
});

test("standalone CLI: usage and read errors exit 2; check/spec work", async () => {
  assert.equal((await cli(["check-log"])).code, 2);
  assert.equal((await cli(["check", join(tmpdir(), "no-such-agentish-file")])).code, 2);
  assert.equal((await cli(["bogus"])).code, 2);
  const dir = mkdtempSync(join(tmpdir(), "agentish-one-"));
  const f = join(dir, "m.txt");
  writeFileSync(f, valid[0].msg);
  assert.equal((await cli(["check", f])).code, 0);
  assert.equal(JSON.parse((await cli(["spec", "--json"])).out).uri, "urn:aibroker:a2a:ext:agentish:2");
});

test("cli.ts imports only ./index.js among repo modules", () => {
  const src = readFileSync(join(here, "..", "src", "agentish", "cli.ts"), "utf8");
  const imports = [...src.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
  for (const i of imports) assert.ok(i.startsWith("node:") || i === "./index.js", i);
});
