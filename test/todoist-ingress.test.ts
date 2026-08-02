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

const {
  grantIngress, revokeIngress, listGrants, applyGrants, projectForOwner, expandThroughSubtree,
} = await import("../src/daemon/todoist-ingress.js");
const { ancestorsOf } = await import("../src/daemon/todoist-projects.js");

/** Grants persist across tests in one file — each subtree case owns the store. */
function clearGrants(): void {
  for (const g of listGrants()) revokeIngress(g.projectId);
}
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

// ── finding the project you already have ────────────────────────────────────

test("an owner resolves to its project, separators folded", () => {
  // A session knows itself as `jobs-matthias`; the human made `Jobs Matthias`.
  // Comparing those literally is how a second project gets created and the
  // work splits across two lists.
  grantIngress("p-jobs", { owner: "jobs-matthias", projectName: "Jobs Matthias" });
  assert.equal(projectForOwner("jobs-matthias")?.projectId, "p-jobs");
  assert.equal(projectForOwner("Jobs Matthias")?.projectId, "p-jobs");
  assert.equal(projectForOwner("JOBS_MATTHIAS")?.projectId, "p-jobs");
});

test("an unknown owner resolves to nothing rather than a near match", () => {
  // Returning the wrong project would be worse than returning none: the caller
  // would file into it confidently.
  assert.equal(projectForOwner("jobs-grazyna"), undefined);
});


// ── folders are not owners ──────────────────────────────────────────────────
//
// Matthias nested "Executive Search 🎯" under "Jobs Matthias". Eighteen tasks
// moved out of the allowlist by being tidied up, and every one was refused with
// "not an ingress project" — silently, and precisely when someone organised
// their work. A sub-project is a folder; ownership belongs to the granted root.

const tree = new Map([
  ["root", { id: "root", name: "Claude 🤖" }],
  ["jobs", { id: "jobs", name: "Jobs Matthias", parentId: "root" }],
  ["exec", { id: "exec", name: "Executive Search 🎯", parentId: "jobs" }],
  ["deep", { id: "deep", name: "Deeper", parentId: "exec" }],
  ["other", { id: "other", name: "Somewhere else" }],
]);

test("a child of a subtree grant is allowed and inherits its owner", () => {
  grantIngress("jobs", { owner: "jobs-matthias", subtree: true });
  const live = expandThroughSubtree(base, "exec", ancestorsOf("exec", tree));
  assert.ok(live.ingressProjectIds.has("exec"));
  assert.equal(live.projectOwners.get("exec"), "jobs-matthias");
});

test("inheritance reaches any depth, not just direct children", () => {
  // The PAI bug was root-plus-one-level. A grandchild was never even queried.
  grantIngress("jobs", { owner: "jobs-matthias", subtree: true });
  const live = expandThroughSubtree(base, "deep", ancestorsOf("deep", tree));
  assert.ok(live.ingressProjectIds.has("deep"));
  assert.equal(live.projectOwners.get("deep"), "jobs-matthias");
});

test("a grant WITHOUT subtree does not cover its children", () => {
  // Subtree is opt-in. Nothing becomes an ingress that nobody granted.
  clearGrants();
  grantIngress("jobs", { owner: "jobs-matthias" });
  const live = expandThroughSubtree(base, "exec", ancestorsOf("exec", tree));
  assert.equal(live.ingressProjectIds.has("exec"), false);
});

test("a project outside every granted tree stays refused", () => {
  clearGrants();
  grantIngress("jobs", { owner: "jobs-matthias", subtree: true });
  const live = expandThroughSubtree(base, "other", ancestorsOf("other", tree));
  assert.equal(live.ingressProjectIds.has("other"), false);
});

test("an already-allowed project is returned untouched", () => {
  // The ordinary path must cost nothing.
  clearGrants();
  const live = expandThroughSubtree(base, "from-env", []);
  assert.equal(live, base, "same object — no copy, no work");
});

test("ancestorsOf survives a cycle rather than hanging", () => {
  // A hung receiver is indistinguishable from a webhook that never arrived.
  const bad = new Map([
    ["a", { id: "a", name: "a", parentId: "b" }],
    ["b", { id: "b", name: "b", parentId: "a" }],
  ]);
  assert.deepEqual(ancestorsOf("a", bad), ["b"]);
});

// ── a folder named after a session belongs to it ────────────────────────────
//
// A granted root is often a container with no owner of its own — "Claude 🤖" is
// not a session — and its children are named after the sessions they serve:
// Home, SL, Whazaa. Without name inference every one of them inherits nothing
// and falls to the default owner. Three such projects were created in one
// afternoon and all were silently unreachable.

const KNOWN_OWNERS = ["home", "sl", "whazaa", "jobs-matthias"];

test("a child of an ownerless granted root takes its own name as owner", () => {
  clearGrants();
  grantIngress("root", { subtree: true });          // no owner: it is a folder
  const live = expandThroughSubtree(base, "home-id", ["root"], { name: "Home", known: KNOWN_OWNERS });
  assert.ok(live.ingressProjectIds.has("home-id"));
  assert.equal(live.projectOwners.get("home-id"), "home");
});

test("the granting ancestor's owner still wins over the name", () => {
  // "Executive Search 🎯" under "Jobs Matthias" belongs to jobs-matthias, not to
  // a session called Executive Search — a folder is not a second owner.
  clearGrants();
  grantIngress("jobs", { owner: "jobs-matthias", subtree: true });
  const live = expandThroughSubtree(base, "exec-id", ["jobs"], { name: "Executive Search 🎯", known: KNOWN_OWNERS });
  assert.equal(live.projectOwners.get("exec-id"), "jobs-matthias");
});

test("name matching folds separators", () => {
  clearGrants();
  grantIngress("root", { subtree: true });
  const live = expandThroughSubtree(base, "jm-id", ["root"], { name: "Jobs Matthias", known: KNOWN_OWNERS });
  assert.equal(live.projectOwners.get("jm-id"), "jobs-matthias");
});

test("a name matching nothing leaves the owner unset, not guessed", () => {
  // Allowed through the subtree, but routed by the ordinary rules — inventing
  // an owner from a name nobody recognises would be worse than falling through.
  clearGrants();
  grantIngress("root", { subtree: true });
  const live = expandThroughSubtree(base, "misc-id", ["root"], { name: "Shopping", known: KNOWN_OWNERS });
  assert.ok(live.ingressProjectIds.has("misc-id"));
  assert.equal(live.projectOwners.get("misc-id"), undefined);
});
