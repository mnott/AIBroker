import "./home-guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { otaCurlArgs } from "../src/mcp/ota-args.js";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { splitVersion, resolveOtaInput, deriveBuild } from "../src/ota/publish.js";

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

test("deriveBuild finds aapt in ANDROID_HOME build-tools when not on PATH", () => {
  const sdk = mkdtempSync(join(tmpdir(), "fake-sdk-"));
  for (const v of ["9.0.0", "35.0.0"]) {
    mkdirSync(join(sdk, "build-tools", v), { recursive: true });
    const code = v === "35.0.0" ? "40" : "1";
    const f = join(sdk, "build-tools", v, "aapt");
    writeFileSync(f, `#!/bin/sh\necho "package: name='x' versionCode='${code}' versionName='1.1.23'"\n`);
    chmodSync(f, 0o755);
  }
  const apk = join(sdk, "a.apk");
  writeFileSync(apk, "x");
  assert.equal(deriveBuild(apk, "android", { ...process.env, ANDROID_HOME: sdk }), "40");
});
