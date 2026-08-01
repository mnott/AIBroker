/**
 * test/todoist-ingress.test.ts — granting a project the right to execute.
 *
 * This is the security boundary: a task filed into an allowed project becomes
 * an instruction a session runs with the user's full rights, and Todoist's own
 * payload documents that the initiator may be a collaborator on a shared
 * project. Making grants editable at runtime must not make them implicit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "aibroker-ingress-"));
process.env.HOME = scratch;
mkdirSync(join(scratch, ".aibroker"), { recursive: true });

const { grantIngress, revokeIngress, listGrants, applyGrants } = await import("../src/daemon/todoist-ingress.js");
import type { WebhookConfig } from "../src/daemon/todoist-webhook.js";

const base: WebhookConfig = {
  secret: "s", port: 1, bind: "127.0.0.1", path: "/todoist", oauthPath: "/oauth",
  ingressProjectIds: new Set(["from-env"]),
  projectOwners: new Map([["from-env", "broker"]]),
  defaultOwner: "broker",
};

test("a grant is additive — the environment list keeps working", () => {
  grantIngress("new-project", { owner: "whazaa", projectName: "Whazaa" });
  const live = applyGrants(base);
  assert.ok(live.ingressProjectIds.has("from-env"), "env entry survives");
  assert.ok(live.ingressProjectIds.has("new-project"), "grant is in effect");
  assert.equal(live.projectOwners.get("whazaa"), undefined);
  assert.equal(live.projectOwners.get("new-project"), "whazaa");
});

test("applyGrants does not mutate the config it was handed", () => {
  // The daemon holds one config for its lifetime; a per-request merge that
  // edits it in place would make a revoked grant impossible to undo.
  const before = new Set(base.ingressProjectIds);
  applyGrants(base);
  assert.deepEqual([...base.ingressProjectIds], [...before]);
});

test("granting twice updates rather than duplicating", () => {
  grantIngress("twice", { owner: "a" });
  grantIngress("twice", { owner: "b" });
  const matching = listGrants().filter((g) => g.projectId === "twice");
  assert.equal(matching.length, 1);
  assert.equal(matching[0].owner, "b");
});

test("revoking removes it from the live config", () => {
  grantIngress("temp", { owner: "clickr" });
  assert.ok(applyGrants(base).ingressProjectIds.has("temp"));
  assert.equal(revokeIngress("temp"), true);
  assert.equal(applyGrants(base).ingressProjectIds.has("temp"), false);
});

test("revoking something never granted reports that honestly", () => {
  assert.equal(revokeIngress("never-existed"), false);
});

test("an unreadable store does not silently empty the allowlist", () => {
  // Rewriting a store we could not parse would turn corruption into a wide-open
  // — or here, a closed — boundary without anyone noticing. Grants from it are
  // simply not in effect, and the env list still stands.
  writeFileSync(join(scratch, ".aibroker", "todoist-ingress.json"), "{ not json", "utf8");
  const live = applyGrants(base);
  assert.ok(live.ingressProjectIds.has("from-env"));
  assert.equal(live.ingressProjectIds.size, 1);
});

// ── a grant must not outlive its project ────────────────────────────────────

test("a revoked grant leaves the rest of the allowlist alone", () => {
  // Deleting one project must not disturb the others: a boundary that shifts
  // more than you asked it to is worse than one that shifts too little.
  grantIngress("keep-me", { owner: "broker" });
  grantIngress("delete-me", { owner: "clickr" });
  assert.equal(revokeIngress("delete-me"), true);
  const live = applyGrants(base);
  assert.ok(live.ingressProjectIds.has("keep-me"));
  assert.equal(live.ingressProjectIds.has("delete-me"), false);
  assert.ok(live.ingressProjectIds.has("from-env"), "the env list is untouched");
});

test("revoking is idempotent, so a repeated delete event is harmless", () => {
  // Todoist retries deliveries. A second project:deleted for the same project
  // must not error or resurrect anything.
  grantIngress("gone", { owner: "broker" });
  assert.equal(revokeIngress("gone"), true);
  assert.equal(revokeIngress("gone"), false);
});
