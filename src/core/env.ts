/**
 * core/env.ts — read ~/.aibroker/env into the process environment.
 *
 * A launchd-managed daemon inherits almost nothing, so credentials cannot live
 * in a shell profile. They live in this file instead, and both the daemon and
 * the CLI have to read it the same way — a CLI that cannot see the same client
 * id as the daemon produces contradictory errors about the same configuration.
 *
 * Existing variables always win: an explicit `FOO=bar aibroker ...` is the
 * caller overriding the file, not a conflict to resolve.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Returns how many variables were newly set, so callers can report it. */
export function loadEnvFile(appDir: string = join(homedir(), ".aibroker")): number {
  const envFile = join(appDir, "env");
  if (!existsSync(envFile)) return 0;

  let loaded = 0;
  try {
    for (const line of readFileSync(envFile, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = value;
        loaded++;
      }
    }
  } catch {
    // An unreadable env file is a configuration problem, not a reason to fail
    // to start: the caller reports what it could not read and carries on.
    return loaded;
  }
  return loaded;
}
