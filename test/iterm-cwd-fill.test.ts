import { test } from "node:test";
import assert from "node:assert/strict";
import { parseItermPath, snapshotAllSessions, invalidateSnapshotCache, _internal } from "../src/adapters/iterm/core.js";

test("parseItermPath accepts absolute paths only", () => {
  assert.equal(parseItermPath("/a/b"), "/a/b");
  assert.equal(parseItermPath("missing value"), null);
  assert.equal(parseItermPath(""), null);
  assert.equal(parseItermPath(undefined), null);
});

test("snapshot fills cwd from the sixth JXA column; older 5-column rows give null", () => {
  const original = _internal.runItermJxa;
  try {
    _internal.runItermJxa = () => ["A\tn\t/dev/ttyz901\tt\t\t/x/CaseLeaf", "B\tn\t/dev/ttyz902\tt\t"].join("\n") + "\n";
    invalidateSnapshotCache();
    const snaps = snapshotAllSessions({ fresh: true });
    assert.equal(snaps.find((s) => s.id === "A")?.cwd, "/x/CaseLeaf");
    assert.equal(snaps.find((s) => s.id === "B")?.cwd, null);
  } finally {
    _internal.runItermJxa = original;
    invalidateSnapshotCache();
  }
});

import { parseLsofCwds } from "../src/adapters/iterm/core.js";
test("parseLsofCwds maps pid to cwd and skips non-paths", () => {
  const m = parseLsofCwds("p101\nfcwd\nn/a/b\np102\nfcwd\nn(deleted)\np103\nn/c\n");
  assert.deepEqual([...m], [["101", "/a/b"], ["103", "/c"]]);
});
