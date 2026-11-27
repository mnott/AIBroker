import "./home-guard.js";
/**
 * test/mailbox-help.test.ts — the mailbox help text must advertise --follow.
 *
 * PAI detects follow support by reading the help text printed for
 * `aibroker mailbox wait --help` / `aibroker mailbox --help`; if --follow is
 * missing it falls back to the old one-shot waiter even though
 * src/daemon/mailbox-cli.ts accepts the flag. So the flag must appear in the
 * usage line and be explained.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "..", "src", "daemon", "cli.ts");

// Reuse this process's own tsx loader (execArgv): `npx tsx` re-resolved tsx
// over the network on every call (10-20 s, >30 s under load) since tsx is not
// a dependency.
function runHelp(args: string[]): string {
  const r = spawnSync(process.execPath, [...process.execArgv, CLI, ...args], {
    env: { ...process.env, __CFBundleIdentifier: "" },
    encoding: "utf8",
    timeout: 60000,
  });
  assert.equal(r.status, 0, `help exited ${r.status}: ${r.stderr}`);
  return r.stdout + r.stderr;
}

test("mailbox --help lists --follow with an explanation", () => {
  const out = runHelp(["mailbox", "--help"]);
  assert.match(out, /\[--follow\]/, "usage line must list [--follow]");
  assert.match(out, /--follow: keep running/, "--follow must be explained");
});

test("mailbox wait --help lists --follow", () => {
  const out = runHelp(["mailbox", "wait", "--help"]);
  assert.match(out, /\[--follow\]/, "usage line must list [--follow]");
});

test("command list (aibroker help) mentions --follow", () => {
  const out = runHelp(["help"]);
  assert.match(out, /--follow/, "the command list must mention --follow");
});
