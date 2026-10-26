import { test } from "node:test";
import assert from "node:assert/strict";
import { cwdProject, displayName, cwdMatches, selfSendError, matchSession } from "../src/core/session-match.js";

test("self send is refused naming both", () => {
  const e = selfSendError("A-1", "A-1", "PAI", "PAI");
  assert.match(e!, /same session/);
  assert.match(e!, /"PAI"/);
});
test("different or unknown sender is not self", () => {
  assert.equal(selfSendError("A-1", "B-2", "x", "y"), null);
  assert.equal(selfSendError(undefined, "B-2", "x", "y"), null);
});
test("displayName shows cwd project only when it differs", () => {
  assert.equal(displayName("PAI", "/dev/apps/CaseLeaf"), "PAI (CaseLeaf)");
  assert.equal(displayName("PAI", "/dev/ai/PAI/"), "PAI");
  assert.equal(displayName("Case Leaf", "/x/case-leaf"), "Case Leaf");
  assert.equal(displayName("PAI", null), "PAI");
  assert.equal(cwdProject("/a/b/"), "b");
});
test("target resolution prefers the session whose cwd matches the name", () => {
  const snaps = [
    { id: "wrong", name: "x", paiName: "PAI", cwd: "/apps/CaseLeaf" },
    { id: "right", name: "y", paiName: "PAI", cwd: "/ai/PAI" },
  ];
  const prefer = (s: any) => 1 + (cwdMatches("PAI", s.cwd) ? 0.5 : 0);
  assert.equal(matchSession(["PAI"], snaps, { kinds: ["exact"], prefer })!.session.id, "right");
});
