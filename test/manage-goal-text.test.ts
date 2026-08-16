/**
 * The typed-goal invariant.
 *
 * A managed session is steered by text typed at its prompt. At a prompt the
 * newline IS the submit key, so any line break inside that text ends the
 * message early and turns the rest into a second, contextless prompt. That
 * failure is invisible in the state file — the objective stored there is
 * correct; only what arrived is wrong — which is exactly why it needs a test
 * rather than care.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { oneLine } from "../src/daemon/manage.js";

test("a multi-line objective is flattened before it is typed", () => {
  const out = oneLine("/goal fix the toolbar\n\nAlso: leave the source alone");
  assert.equal(out.includes("\n"), false);
  assert.equal(out, "/goal fix the toolbar Also: leave the source alone");
});

test("carriage returns and CRLF collapse too, not just newlines", () => {
  assert.equal(oneLine("a\r\nb\rc"), "a b c");
});

test("a run of blank lines becomes one space, not many", () => {
  assert.equal(oneLine("a\n\n\n   \n b"), "a b");
});

test("leading and trailing whitespace is dropped so the goal starts at its first word", () => {
  assert.equal(oneLine("\n  /goal do the thing  \n"), "/goal do the thing");
});

test("text that is already one line is returned unchanged", () => {
  const already = "/goal do the thing and then the other thing";
  assert.equal(oneLine(already), already);
});

test("spacing inside a line is preserved — only line breaks are structural", () => {
  assert.equal(oneLine("a  b\nc  d"), "a  b c  d");
});
