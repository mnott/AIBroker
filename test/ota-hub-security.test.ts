import "./home-guard.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "ota-"));
const paths = await import("../docker/ota/src/paths.js");
const auth = await import("../docker/ota/src/auth.js");

describe("ota hub security", () => {
  it("rejects invalid slugs", () => {
    assert.equal(paths.isValidSlug("my-app1"), true);
    assert.equal(paths.isValidSlug(".."), false);
    assert.throws(() => paths.slugDir(".."));
    assert.equal(paths.readMeta(".."), null);
  });
  it("sanitises upload file names", () => {
    const f = paths.safeFileName("../../x", "1/2", ".ipa");
    assert.doesNotMatch(f, /[\/]/);
    assert.equal(f.startsWith("."), false);
  });
  it("rejects traversal in served files", () => {
    const d = paths.slugDir("a");
    assert.equal(paths.isSafeFileInDir(d, "x.ipa"), true);
    for (const f of ["../meta.json", "a/b", ".hidden", ".."]) assert.equal(paths.isSafeFileInDir(d, f), false);
  });
  it("matches publishers exactly", () => {
    assert.equal(auth.isPublisher("evilbob@x.com", ["bob@x.com"]), false);
    assert.equal(auth.isPublisher("Bob@x.com", ["bob@x.com"]), true);
    assert.equal(auth.isPublisher("bob@x.com", []), false);
  });
});
