/**
 * test/ota-args.test.ts — ota_publish builds curl argv without a shell.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { otaCurlArgs } from "../src/mcp/ota-args.js";

const fields = {
  slug: "app", name: "A B", bundleId: "com.x.y", version: "1.1.4 (13)", platform: "ios", filePath: "/tmp/a b.ipa",
};

test("values with spaces and parentheses stay single argv elements", () => {
  const a = otaCurlArgs(8767, fields);
  assert.ok(a.includes("version=1.1.4 (13)"));
  assert.ok(a.includes("name=A B"));
});

test("text fields use --form-string, file uses -F", () => {
  const a = otaCurlArgs(8767, { ...fields, name: "@/etc/passwd" });
  for (const k of ["slug=app", "name=@/etc/passwd", "bundleId=com.x.y", "version=1.1.4 (13)", "platform=ios"]) {
    assert.equal(a[a.indexOf(k) - 1], "--form-string");
  }
  assert.equal(a[a.indexOf("file=@/tmp/a b.ipa") - 1], "-F");
  assert.ok(a.includes("http://127.0.0.1:8767/api/apps"));
});
