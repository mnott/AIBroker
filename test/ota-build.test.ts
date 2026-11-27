import "./home-guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { otaCurlArgs } from "../src/mcp/ota-args.js";
import { splitVersion, resolveOtaInput } from "../src/ota/publish.js";

const base = { slug: "a", name: "A", bundleId: "b.c", version: "1.0", platform: "ios", filePath: "/nonexistent.ipa" };

test("otaCurlArgs sends build when given", () => {
  const a = otaCurlArgs(1, { ...base, build: "40" });
  assert.ok(a.includes("build=40"));
  assert.equal(a[a.indexOf("build=40") - 1], "--form-string");
});

test("otaCurlArgs omits build when absent", () => {
  assert.ok(!otaCurlArgs(1, base).some((x) => x.startsWith("build=")));
});

test("splitVersion splits 'V (B)'", () => {
  assert.deepEqual(splitVersion("1.1.23 (40)"), { version: "1.1.23", build: "40" });
  assert.deepEqual(splitVersion("1.1.23"), { version: "1.1.23" });
});

test("resolveOtaInput: split version, explicit build wins, underivable build skipped", () => {
  const r = resolveOtaInput({ ...base, version: "1.1.23 (40)" });
  assert.equal(r.version, "1.1.23");
  assert.equal(r.build, "40");
  assert.equal(resolveOtaInput({ ...base, version: "1.1.23 (40)", build: "7" }).build, "7");
  assert.equal(resolveOtaInput(base).build, undefined);
});
