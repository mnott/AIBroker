import "./home-guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { expandTilde, resolveLaunchDir } from "../src/core/launch-dir.js";
import { itermLaunchLine } from "../src/transport/iterm.js";
import { setAppDir, setPersistentSessionName, setSessionProject } from "../src/core/persistence.js";
import { resumableSessionsForDir } from "../src/core/session-discovery.js";

test("tilde expands to the home directory, other paths untouched", () => {
  assert.equal(expandTilde("~"), homedir());
  assert.equal(expandTilde("~/x"), join(homedir(), "x"));
  assert.equal(expandTilde("/a/~b"), "/a/~b");
});

test("iterm launch builder expands ~ before quoting", () => {
  const line = itermLaunchLine({ dir: "~", name: "Home", resume: true } as never);
  assert.ok(line.startsWith(`cd '${homedir()}' && claude --name 'Home'`), line);
  assert.ok(!line.includes("'~'"));
  assert.equal(itermLaunchLine({ dir: "~" } as never), `cd '${homedir()}' && claude`);
});

test("nonexistent directory is refused with a clear error", () => {
  assert.throws(() => resolveLaunchDir("/nonexistent/dir-xyz"), /does not exist/);
  assert.throws(() => itermLaunchLine({ dir: "~/no-such-dir-xyz" } as never), /does not exist/);
});

test("folder search offers earlier sessions recorded for that folder (home included)", () => {
  const app = mkdtempSync(join(tmpdir(), "aib-home-"));
  try {
    setAppDir(app);
    setPersistentSessionName("old-home", "Home");
    setSessionProject("old-home", homedir());
    setPersistentSessionName("live-home", "Home2");
    setSessionProject("live-home", homedir());
    setPersistentSessionName("other", "Other");
    setSessionProject("other", "/somewhere/else");
    const r = resumableSessionsForDir("~", new Set(["live-home"]));
    assert.deepEqual(r, [{ id: "old-home", name: "Home" }]);
  } finally { rmSync(app, { recursive: true, force: true }); }
});
