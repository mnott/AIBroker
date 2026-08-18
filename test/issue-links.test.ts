/**
 * test/issue-links.test.ts — a report that names an issue must link to it.
 *
 * The rule was written down politely and forgotten three times in one evening,
 * so the tool refuses instead. The tests that matter here are the ones that
 * keep the refusal NARROW: an over-eager gate that blocks ordinary messages
 * would be worse than the missing links, because it would be worked around.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { missingIssueLink } from "../src/mcp/issue-links.js";

// ── what it must refuse ──────────────────────────────────────────────────────

test("naming an issue with no link at all is refused", () => {
  const c = missingIssueLink("#4 and #159 done — they are the same report.");
  assert.equal(c?.ref, "#4");
  assert.match(c?.message ?? "", /carries no link/);
  assert.match(c?.message ?? "", /html_url/, "it says where the address comes from");
});

test("the refusal names the issue, so the reader knows which one to link", () => {
  assert.equal(missingIssueLink("Taking #173 next.")?.ref, "#173");
});

test("a reference in brackets or after a bracket still counts", () => {
  assert.ok(missingIssueLink("Done (#12) this evening."));
  assert.ok(missingIssueLink("[#12] is fixed."));
});

// ── what it must let through ─────────────────────────────────────────────────

test("a message with a link is fine, markdown or bare", () => {
  assert.equal(missingIssueLink("#4 done: https://example.test/APPS/x/issues/4#issuecomment-9"), undefined);
  assert.equal(missingIssueLink("[#4](https://example.test/issues/4) is done"), undefined);
});

test("a message that names no issue is never touched", () => {
  // A greeting is not a report. An over-eager gate gets worked around.
  assert.equal(missingIssueLink("hi"), undefined);
  assert.equal(missingIssueLink("Shift started, screen is mine for 8 hours."), undefined);
});

test("a number that is not an issue reference does not trigger it", () => {
  assert.equal(missingIssueLink("colour #ff0000 looks wrong"), undefined, "a hex colour");
  assert.equal(missingIssueLink("the heading uses ###"), undefined, "markdown");
  assert.equal(missingIssueLink("see issue no 4"), undefined, "no hash, no claim to be a reference");
});

test("a hash inside a word or a URL fragment is not a reference", () => {
  assert.equal(missingIssueLink("the file build#4.log"), undefined);
  assert.equal(missingIssueLink("read https://example.test/page#4 for context"), undefined);
});

test("an absurdly long number is not an issue", () => {
  assert.equal(missingIssueLink("the id #1234567890 came back"), undefined);
});
