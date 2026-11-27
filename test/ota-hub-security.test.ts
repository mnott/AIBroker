import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.stubEnv("DATA_DIR", mkdtempSync(join(tmpdir(), "ota-")));
const paths = await import("../docker/ota/src/paths.js");
const auth = await import("../docker/ota/src/auth.js");

describe("ota hub security", () => {
  it("rejects invalid slugs", () => {
    expect(paths.isValidSlug("my-app1")).toBe(true);
    expect(paths.isValidSlug("..")).toBe(false);
    expect(() => paths.slugDir("..")).toThrow();
    expect(paths.readMeta("..")).toBeNull();
  });
  it("sanitises upload file names", () => {
    const f = paths.safeFileName("../../x", "1/2", ".ipa");
    expect(f).not.toMatch(/[\/]/);
    expect(f.startsWith(".")).toBe(false);
  });
  it("rejects traversal in served files", () => {
    const d = paths.slugDir("a");
    expect(paths.isSafeFileInDir(d, "x.ipa")).toBe(true);
    for (const f of ["../meta.json", "a/b", ".hidden", ".."]) expect(paths.isSafeFileInDir(d, f)).toBe(false);
  });
  it("matches publishers exactly", () => {
    expect(auth.isPublisher("evilbob@x.com", ["bob@x.com"])).toBe(false);
    expect(auth.isPublisher("Bob@x.com", ["bob@x.com"])).toBe(true);
    expect(auth.isPublisher("bob@x.com", [])).toBe(false);
  });
});
