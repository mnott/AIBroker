/**
 * test/home-guard.ts — no test may touch anything a user owns.
 *
 * Preloaded before any test module, because that is the only moment that
 * works: paths like `join(homedir(), ".aibroker")` are module-level constants
 * evaluated at import, so a guard that runs per-test is already too late. That
 * is exactly how test/message-queue.test.ts overwrote the live PAILot offline
 * queue on every run — 95 MB of buffered messages replaced by eight fixtures,
 * unrecoverable, and reported by nothing, because a test that destroys
 * production data still passes.
 *
 * Individual suites redirecting HOME themselves is not enough. It has to hold
 * at a site nobody has thought of yet, including one added next month.
 *
 * USERPROFILE is included because os.homedir() prefers it on Windows and
 * ignores HOME — setting only HOME would leave this half-applied on a platform
 * nobody tests on until it matters.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "aibroker-test-home-"));

process.env.HOME = sandbox;
process.env.USERPROFILE = sandbox;
process.env.XDG_CONFIG_HOME = join(sandbox, ".config");

/** Read by the guard's own test — an unwired preload is silent by construction. */
process.env.AIBROKER_TEST_HOME = sandbox;
