/**
 * test/todoist-owners.test.ts — a comment reaches the session doing the work.
 *
 * Re-deriving the owner from the parent task's project and labels is NOT the
 * same as remembering who took it. The original may have been addressed in its
 * title — "pai send me a mail" — while the correction says only "make it next
 * month". Re-derive and that correction lands wherever the project mapping
 * points, which is a different session than the one holding the work.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "aibroker-owners-"));
process.env.HOME = scratch;
mkdirSync(join(scratch, ".aibroker"), { recursive: true });

const { rememberOwner, ownerOf, forgetAllOwners } = await import("../src/daemon/todoist-owners.js");
const { route } = await import("../src/daemon/todoist-webhook.js");
import type { WebhookConfig, TodoistEvent } from "../src/daemon/todoist-webhook.js";

const cfg: WebhookConfig = {
  secret: "s", port: 1, bind: "127.0.0.1", path: "/todoist", oauthPath: "/oauth",
  ingressProjectIds: new Set(["p"]),
  projectOwners: new Map([["p", "whazaa"]]),
  defaultOwner: "broker",
};

const comment = (content: string): TodoistEvent => ({
  event_name: "note:added",
  event_data: { id: "task-7", content, project_id: "p", labels: [] },
});

test("an owner survives a round trip", () => {
  forgetAllOwners();
  rememberOwner("task-7", "pai");
  assert.equal(ownerOf("task-7"), "pai");
  assert.equal(ownerOf("never-seen"), undefined);
});

test("a comment goes to the session holding the task, not to the project owner", () => {
  forgetAllOwners();
  rememberOwner("task-7", "pai");
  const d = route(comment("make it next month instead"), cfg, ["pai", "whazaa", "broker"], ownerOf("task-7"));
  assert.equal(d.act && d.project, "pai", "not whazaa, which the project mapping would pick");
  assert.equal(d.act && d.rule, "held");
});

test("an explicit address in the comment still overrides who holds it", () => {
  forgetAllOwners();
  rememberOwner("task-7", "pai");
  const d = route(comment("whazaa take this one over"), cfg, ["pai", "whazaa", "broker"], ownerOf("task-7"));
  assert.equal(d.act && d.project, "whazaa");
  assert.equal(d.act && d.rule, "address");
});

test("with nothing remembered a comment falls back to the project mapping", () => {
  forgetAllOwners();
  const d = route(comment("any update?"), cfg, ["pai", "whazaa", "broker"], ownerOf("task-7"));
  assert.equal(d.act && d.project, "whazaa");
  assert.equal(d.act && d.rule, "project");
});

test("the cache is bounded and forgets oldest first", () => {
  forgetAllOwners();
  for (let i = 0; i < 520; i++) rememberOwner(`t-${i}`, "broker");
  assert.equal(ownerOf("t-0"), undefined, "oldest dropped");
  assert.equal(ownerOf("t-519"), "broker", "newest kept");
});

test("re-recording a task does not grow the cache", () => {
  forgetAllOwners();
  for (let i = 0; i < 10; i++) rememberOwner("same", `owner-${i}`);
  assert.equal(ownerOf("same"), "owner-9", "latest wins");
});
