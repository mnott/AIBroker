/**
 * core/env-bootstrap.ts — side-effect-only import that loads ~/.aibroker/env
 * before anything else in the module graph evaluates.
 *
 * Several modules read process.env into module-level consts at import time
 * (sync-facade's AIBROKER_TRANSPORT, audit's AIBROKER_AUDIT_FILE, gateway's
 * PAILOT_DEBUG/PAILOT_PORT). Under launchd those vars only exist once
 * loadEnvFile() runs, but ES module imports are evaluated before any
 * function body — including the one that used to call loadEnvFile() deep
 * inside startDaemon(). Importing this file FIRST in every CLI entrypoint
 * guarantees the env file is loaded before those modules' top-level reads.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { loadEnvFile } from "./env.js";
import { log } from "./log.js";

const loaded = loadEnvFile();
if (loaded > 0) {
  log(`Loaded ${loaded} env var(s) from ${join(homedir(), ".aibroker", "env")}`);
}
