import "./home-guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkPublicText, assertPublicSafe, twinBranchName } from "../src/core/public-sanitizer.js";

const rules = (t: string, x: string[] = []) => new Set(checkPublicText(t, x).hits.map((h) => h.rule));

const CASES: Array<[string, string]> = [
  ["ipv4", "server at 10.0.3.17 fails"],
  ["ipv6", "host 2001:db8::1 fails"],
  ["internal-host", "see nas.local"],
  ["internal-host", "see git.mnsoft.org"],
  ["internal-host", "http://localhost:3000"],
  ["fs-path", "in /Users/someone/code"],
  ["fs-path", "in /home/bob/x"],
  ["fs-path", "at /var/folders/ab/cd"],
  ["fs-path", "at /Volumes/Disk/x"],
  ["fs-path", "at ~/notes/a.md"],
  ["fs-path", "at C:\\Users\\bob"],
  ["email", "mail a.b@example.com"],
  ["private-key", "-----BEGIN RSA PRIVATE KEY-----"],
  ["token", "ghp_abcdefghijklmnop1234"],
  ["token", "AKIAABCDEFGHIJKLMNOP"],
  ["token", "xoxb-1234567890-abc"],
  ["secret-assignment", "password=" + "a1b2c3d4".repeat(5)],
  ["forge-ref", "see APPS/AIBroker#7"],
  ["internal-id", "worker 20261127-202615-46662"],
];
for (const [rule, text] of CASES) {
  test(`${rule} refused: ${text}`, () => {
    const r = checkPublicText(text);
    assert.equal(r.ok, false);
    assert.ok(rules(text).has(rule), [...rules(text)].join());
  });
}

test("neutral feature request passes", () => {
  const r = checkPublicText("Please add a dark mode option to the settings screen; version 1.2.3 works fine.");
  assert.deepEqual(r, { ok: true, hits: [] });
});

test("extra deny terms match whole words, case-insensitively", () => {
  assert.equal(checkPublicText("the Acme build", ["acme"]).ok, false);
  assert.equal(checkPublicText("acmeology", ["acme"]).ok, true);
});

test("assertPublicSafe lists rules and counts, not the match", () => {
  assert.throws(() => assertPublicSafe("a 10.0.0.1 b 10.0.0.2"), (e: Error) =>
    /ipv4 x2/.test(e.message) && !e.message.includes("10.0.0.1"));
  assert.doesNotThrow(() => assertPublicSafe("clean text"));
});

test("twinBranchName", () => {
  assert.equal(twinBranchName(12), "gh-pr-12");
  for (const bad of [0, -1, 1.5, NaN]) assert.throws(() => twinBranchName(bad));
});
