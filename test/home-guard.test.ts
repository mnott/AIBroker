/**
 * test/home-guard.test.ts — the guard has to be able to fail.
 *
 * An unwired preload is silent by construction: every other suite keeps passing
 * while quietly writing to the real home again. So the guard asserts itself.
 *
 * Every variable the guard sets is asserted SEPARATELY, and each is checked for
 * being set before being compared. Two controls, because the obvious one is not
 * enough:
 *
 *   no guard at all        -> all four fail   (proves the preload is wired)
 *   guard minus ONE var    -> exactly one     (proves each is load-bearing)
 *
 * The second is the one that matters. A suite where every assertion happens to
 * depend on HOME passes the first control while leaving USERPROFILE — and so
 * every Windows run — unguarded. It reads as covered and is not.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir, tmpdir } from "node:os";

test("the test home is redirected away from the real one", () => {
  assert.ok(
    process.env.AIBROKER_TEST_HOME,
    "home-guard was not preloaded — run tests via `npm test`, which passes --import ./test/home-guard.ts",
  );
  assert.equal(process.env.HOME, process.env.AIBROKER_TEST_HOME);
});

test("os.homedir() itself resolves inside the sandbox", () => {
  // The property that matters: every module-level join(homedir(), …) constant
  // in the codebase lands somewhere disposable.
  assert.ok(
    homedir().startsWith(tmpdir()) || homedir() === process.env.AIBROKER_TEST_HOME,
    `homedir() is ${homedir()}, which is not the sandbox`,
  );
});

test("USERPROFILE is redirected too", () => {
  // homedir() prefers USERPROFILE on Windows and ignores HOME. Asserting both
  // are SET first, or this passes trivially when the guard is missing and both
  // are undefined — a guard test that cannot fail is the thing being guarded
  // against.
  assert.ok(process.env.USERPROFILE, "USERPROFILE is not set — guard not applied");
  assert.equal(process.env.USERPROFILE, process.env.AIBROKER_TEST_HOME);
});

test("XDG_CONFIG_HOME is redirected too", () => {
  // Set by the guard and, until now, asserted by nothing — the same gap PAI
  // found in theirs: three variables redirected, one variable's effect tested.
  // Deleting this line from the guard would have left every assertion green
  // while anything reading XDG_CONFIG_HOME wrote to the real config directory.
  assert.ok(process.env.XDG_CONFIG_HOME, "XDG_CONFIG_HOME is not set — guard not applied");
  assert.ok(
    process.env.XDG_CONFIG_HOME!.startsWith(process.env.AIBROKER_TEST_HOME!),
    `XDG_CONFIG_HOME is ${process.env.XDG_CONFIG_HOME}, outside the sandbox`,
  );
});
