import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invalidatePaiProjectCache, listPaiProjects } from "../src/daemon/pai-projects.js";

test("a failed CLI call serves the last good list and is not cached", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pai-fake-"));
  const flag = join(dir, "fail");
  writeFileSync(join(dir, "pai"), `#!/bin/sh\n[ -e "${flag}" ] && exit 1\necho '[{"name":"a","slug":"a"}]'\n`);
  chmodSync(join(dir, "pai"), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath}`;
  const realNow = Date.now();
  let offset = 0;
  t.mock.method(Date, "now", () => realNow + offset);
  try {
    invalidatePaiProjectCache();
    assert.equal((await listPaiProjects(true)).length, 1);

    offset = 60_000; // past the cache TTL
    writeFileSync(flag, "");
    assert.equal((await listPaiProjects(true)).length, 1, "failure serves the first list");

    unlinkSync(flag);
    assert.equal((await listPaiProjects(true)).length, 1, "failure was not cached, CLI recovers");
  } finally {
    process.env.PATH = oldPath;
    invalidatePaiProjectCache();
  }
});
