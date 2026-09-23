/**
 * test/env-transport-load-order.test.ts — AIBROKER_TRANSPORT set only via
 * ~/.aibroker/env (never the shell env node starts with) must still gate
 * sync-facade before its module-top-level override is evaluated.
 *
 * sync-facade.ts reads process.env.AIBROKER_TRANSPORT into a module-level
 * const at import time. Under launchd the daemon never sees the var until
 * loadEnvFile() runs, which used to happen deep inside startDaemon() — long
 * after sync-facade (and everything else importing it) had already been
 * evaluated. core/env-bootstrap.ts, imported first in every CLI entrypoint,
 * loads the file before any of that. Spawns a real subprocess so the module
 * graph is actually re-evaluated from a fresh env, not the test runner's.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));

test("AIBROKER_TRANSPORT from the env file is loaded before sync-facade evaluates it", () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "aibroker-env-order-"));
  try {
    const appDir = join(fakeHome, ".aibroker");
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, "env"), "AIBROKER_TRANSPORT=iterm\n");

    const probe = join(fakeHome, "probe.ts");
    writeFileSync(
      probe,
      [
        `import ${JSON.stringify(join(projectRoot, "src/core/env-bootstrap.js"))};`,
        `import ${JSON.stringify(join(projectRoot, "src/transport/sync-facade.js"))};`,
      ].join("\n"),
    );

    const childEnv = { ...process.env, HOME: fakeHome };
    delete childEnv.AIBROKER_TRANSPORT;

    const result = spawnSync("npx", ["tsx", probe], {
      env: childEnv,
      encoding: "utf-8",
      timeout: 20_000,
    });

    assert.equal(result.status, 0, `probe process failed: ${result.stderr}`);

    const loadedLine = result.stderr.indexOf("Loaded 1 env var(s)");
    const permittedLine = result.stderr.indexOf("transports permitted = [iterm]");
    assert.notEqual(loadedLine, -1, `expected env-load log line, got:\n${result.stderr}`);
    assert.notEqual(permittedLine, -1, `expected iterm-only permitted line, got:\n${result.stderr}`);
    assert.ok(loadedLine < permittedLine, "env file must load before sync-facade evaluates the override");
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
});
