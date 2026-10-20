import "./home-guard.js";
/**
 * test/mcp-is-entry.test.ts — IS_ENTRY must survive a symlinked launch path.
 *
 * The MCP config launches `node ~/dev/ai/AIBroker/dist/mcp/index.js`, where
 * ~/dev is a symlink. Node resolves import.meta.url through symlinks to the
 * real path, but process.argv[1] stays as given, so a raw comparison is never
 * equal: IS_ENTRY false, main() and registerWithAibp() never run, and the
 * stdio server exits 0 with empty stdout — CONNECTION_CLOSED for every new
 * Claude Code session. Both sides must be realpath'd.
 *
 * The end-to-end repro (initialize answered through both spellings) lives in
 * the proof section of the fix; this pins the comparison itself.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

process.env.ITERM_SESSION_ID = "w0t0p0:MCP-IS-ENTRY-TEST";

const { isEntryPath } = await import("../src/mcp/index.js");

// A temp dir reached through a symlink prefix: realDir is the real file's home,
// linkDir/… names the same file through the symlink.
const root = mkdtempSync(join(tmpdir(), "aibroker-is-entry-"));
const realDir = join(root, "real");
const linkDir = join(root, "link");
mkdirSync(realDir);
const file = join(realDir, "index.js");
writeFileSync(file, "");
symlinkSync(realDir, linkDir);

test("IS_ENTRY true when both paths name the same file through different symlink prefixes", () => {
  // import.meta.url side spelled through the symlink, argv side the real path —
  // exactly the mismatch the launcher produces, in both directions.
  assert.equal(isEntryPath(join(linkDir, "index.js"), file), true, "symlinked module path vs real argv path");
  assert.equal(isEntryPath(file, join(linkDir, "index.js")), true, "real module path vs symlinked argv path");
  assert.equal(isEntryPath(join(linkDir, "index.js"), join(linkDir, "index.js")), true, "both through the symlink");
});

test("IS_ENTRY false when the module is imported, not the entry", () => {
  // argv[1] is the test runner's file, not this module — the import must stay
  // side-effect free (no stdio transport, no AIBP registration).
  const runner = realpathSync(fileURLToPath(import.meta.url));
  assert.equal(isEntryPath(realpathSync(file), runner), false, "imported module vs a different entry");
  // A sibling file under the same symlinked tree is also not the entry.
  const sibling = join(linkDir, "other.js");
  assert.equal(isEntryPath(file, sibling), false, "different file, same directory");
});
