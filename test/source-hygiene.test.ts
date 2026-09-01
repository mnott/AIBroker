/**
 * test/source-hygiene.test.ts — no invisible bytes in the source.
 *
 * A NUL byte reached a template string in this repository and shipped in two
 * releases. At runtime it did nothing: it sat inside a cache key, where any
 * separator works. The damage was to every tool that reads the source. `grep`
 * classifies a file with a control byte as binary and stops printing matches,
 * so a search for a symbol that IS there answers as though it were not — and
 * "not found" is a conclusion people act on. It was noticed only because a
 * search returned nothing at a moment when the answer was known to be otherwise.
 *
 * That is the same shape as the faults this project keeps meeting: an
 * instrument that reports confidently while measuring nothing. A grep that
 * cannot see a file does not say so.
 *
 * Control characters are not banned from the RUNTIME — tmux output is parsed
 * with a 0x01 field separator and must keep it. They are banned from the
 * SOURCE, where `"\u0001"` says the same thing and can be read, searched and
 * reviewed. Any future need is met the same way.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SKIP = /(^|\/)(node_modules|\.git|dist|coverage|templates)(\/|$)/;
const CHECKED = /\.(ts|tsx|js|mjs|cjs|json|md)$/;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (SKIP.test(p)) continue;
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (CHECKED.test(entry)) out.push(p);
  }
  return out;
}

/** Tab, newline and carriage return are the only control bytes text needs. */
const allowed = new Set([0x09, 0x0a, 0x0d]);

test("no source file carries a control byte that would make it unsearchable", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(ROOT)) {
    const buf = readFileSync(file);
    for (let i = 0; i < buf.length; i++) {
      const c = buf[i];
      if (c < 0x20 && !allowed.has(c)) {
        const line = buf.subarray(0, i).toString("utf8").split("\n").length;
        offenders.push(
          `${file.replace(ROOT, "")}:${line} — byte 0x${c.toString(16).padStart(2, "0")}`,
        );
        break;
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "write it as an escape (\\u0001) instead: the runtime value is identical and grep can still read the file\n" +
      offenders.join("\n"),
  );
});

test("the check is actually looking at this repository's files", () => {
  // A sweep that silently matched nothing would pass forever. This is the
  // failure mode the test itself is about, so it does not get to have it.
  const files = sourceFiles(ROOT);
  assert.ok(files.length > 50, `expected the source tree, found ${files.length} files`);
  assert.ok(files.some((f) => f.endsWith("src/daemon/forge-issues.ts")), "the file that caused this must be covered");
  assert.ok(files.some((f) => f.endsWith("src/transport/tmux.ts")), "and the one with a legitimate need for 0x01");
});
