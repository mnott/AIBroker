import "./home-guard.js";
/**
 * An attach viewer's process cwd is HOME; the handover target must come from
 * the cwd the session's transcript records.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionProjectCwd, defaultHandoverTarget, pickHandoverTarget, projectSinkDescription } from "../src/daemon/manage.js";

const UUID = "cdd93e8d-458c-4a63-a9cf-c24488cdd6f4";

function setup() {
  const base = mkdtempSync(join(tmpdir(), "pc-"));
  const home = join(base, "home");
  const project = join(base, "proj");
  mkdirSync(join(home, "Notes"), { recursive: true });
  mkdirSync(join(project, "Notes"), { recursive: true });
  const root = join(base, "projects");
  mkdirSync(join(root, "-proj"), { recursive: true });
  const lines = [
    { type: "user", cwd: home },
    { type: "assistant", cwd: project },
    { type: "system" },
  ];
  writeFileSync(join(root, "-proj", `${UUID}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return { home, project, root };
}

test("attach session: handover target is the project's Notes/TODO.md, not HOME", () => {
  const { home, project, root } = setup();
  const cwd = sessionProjectCwd("1", "cdd93e8d", root, () => home);
  assert.equal(cwd, project);
  const t = pickHandoverTarget({
    sinkDescription: projectSinkDescription(cwd),
    defaultPath: defaultHandoverTarget(cwd, true),
  });
  assert.equal(t.path, join(project, "Notes", "TODO.md"));
});

test("foreground (no uuid) and unknown uuid keep the process cwd", () => {
  const { home, root } = setup();
  assert.equal(sessionProjectCwd("1", undefined, root, () => home), home);
  assert.equal(sessionProjectCwd("1", "ffffffff", root, () => home), home);
});
