import "./home-guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderLanding } from "../docker/ota/src/landing.ts";
import { renderManifest } from "../docker/ota/src/manifest.ts";

const req = { headers: { host: 'x"><script>1</script>' }, protocol: "https" } as any;
const meta = {
  name: "<script>alert(1)</script>",
  version: "1<b>",
  build: '"><img src=x onerror=1>',
  updatedAt: "<i>now</i>",
  bundleId: "a.b</string><x/>",
  ipaFile: "a<b>.ipa",
  apkFile: "a<b>.apk",
  icon: false,
} as any;

for (const [label, out] of [
  ["landing", renderLanding(req, "s<lug>", meta)],
  ["manifest", renderManifest(req, "s<lug>", meta)],
] as const) {
  test(`${label} escapes publisher fields`, () => {
    assert.ok(!out.includes("<script>"));
    assert.ok(!out.includes("<img"));
    assert.ok(!out.includes("<x/>"));
    assert.ok(!out.includes("<b>"));
    assert.ok(out.includes("&lt;script&gt;"));
  });
}
