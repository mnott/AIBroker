/**
 * test/home-guard.test.ts — the guard has to be able to fail.
 *
 * An unwired preload is silent by construction: every other suite keeps passing
 * while quietly writing to the real home again. So the guard asserts itself.
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
