/**
 * test/a2a-agentish-extension.test.ts — AG2 declared as an A2A extension.
 *
 * Covers the AgentCard fragment, the Part tagging/detection helpers, and
 * validation delegating to daemon/agentish.ts's check(). See
 * docs/a2a-agentish-extension.md.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AGENTISH_EXTENSION_URI,
  AGENTISH_SPEC_URL,
  AGENTISH_MEDIA_TYPE,
  agentCardExtension,
  ag2Part,
  isAg2Part,
  validateAg2Part,
} from "../src/a2a/agentish-extension.js";

const VALID_T = [
  "T",
  "i=demo",
  "g=goal",
  "d=step",
  "t=Name",
  "o=@1=/tmp",
  "p=proof",
  "u=out",
].join("\n");

test("agentCardExtension: shape matches AgentExtension (uri, description, required:false, params)", () => {
  const ext = agentCardExtension();
  assert.equal(ext.uri, AGENTISH_EXTENSION_URI);
  assert.equal(typeof ext.description, "string");
  assert.ok(ext.description.length > 0);
  assert.equal(ext.required, false);
  assert.equal(typeof ext.params.spec, "string");
  assert.ok(ext.params.spec.length > 0);
  assert.equal(typeof ext.params.extensions, "string");
  assert.ok(ext.params.extensions.length > 0);
  assert.equal(ext.params.validator, "aibroker agentish check");
});

test("uri-is-urn: AGENTISH_EXTENSION_URI is a urn, not an unresolvable https domain", () => {
  assert.ok(AGENTISH_EXTENSION_URI.startsWith("urn:"));
  assert.equal(AGENTISH_EXTENSION_URI, "urn:aibroker:a2a:ext:agentish:2");
});

test("params-has-version-and-spec-url: agentCardExtension carries a version and a resolvable spec_url", () => {
  const ext = agentCardExtension();
  assert.equal(ext.params.version, "2");
  assert.equal(ext.params.spec_url, AGENTISH_SPEC_URL);
  assert.equal(typeof ext.params.spec_url, "string");
  assert.ok(ext.params.spec_url.length > 0);
});

test("ag2Part: marks metadata.agentish and carries the text verbatim", () => {
  const part = ag2Part(VALID_T);
  assert.equal(part.kind, "text");
  assert.equal(part.text, VALID_T);
  assert.equal(part.metadata?.agentish, "2");
});

test("isAg2Part: false on a plain TextPart with no agentish metadata", () => {
  const plain = { kind: "text" as const, text: "just some prose" };
  assert.equal(isAg2Part(plain), false);
});

test("isAg2Part: false on non-object and on a differently-tagged part", () => {
  assert.equal(isAg2Part(null), false);
  assert.equal(isAg2Part("a string"), false);
  assert.equal(isAg2Part({ kind: "text", text: "x", metadata: { agentish: "1" } }), false);
});

test("isAg2Part-accepts-mimetype-form: true on a part tagged via mediaType instead of metadata", () => {
  const part = { kind: "text" as const, text: VALID_T, mediaType: AGENTISH_MEDIA_TYPE };
  assert.equal(isAg2Part(part), true);
});

test("validateAg2Part: accepts a valid AG2 T message", () => {
  const result = validateAg2Part(ag2Part(VALID_T));
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("validateAg2Part: rejects an unknown kind", () => {
  const badPart = ag2Part("Z\ni=demo");
  const result = validateAg2Part(badPart);
  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0);
});

test("validateAg2Part: rejects a part that isn't tagged as AG2 at all", () => {
  const result = validateAg2Part({ kind: "text", text: VALID_T });
  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0);
});
