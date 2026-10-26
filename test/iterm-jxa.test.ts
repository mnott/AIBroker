/**
 * iTerm is addressed by process id through JXA, never by name/bundle id/path —
 * those resolve through the LaunchServices bundle-id registry, which a
 * bundle-id impostor poisons (-600 / -1708).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseItermPid, buildItermJxa, withSessionJxa, cleanChildEnv } from "../src/adapters/iterm/core.js";

const REAL = "/Applications/iTerm.app/Contents/MacOS/iTerm2";

test("parseItermPid accepts only a process whose executable is iTerm's own", () => {
  const ps = [
    "  100 /usr/bin/osascript",
    "  200 /usr/bin/osascript -e use framework",
    `  300 ${REAL}`,
    "  400 /tmp/fake/iTerm2",
  ].join("\n");
  assert.equal(parseItermPid(ps), 300);
});

test("parseItermPid finds nothing when only impostors are running", () => {
  assert.equal(parseItermPid("  100 /usr/bin/osascript\n  200 /Applications/Other.app/Contents/MacOS/iTerm2"), null);
  assert.equal(parseItermPid(""), null);
});

test("parseItermPid handles a relocated install and padded pids", () => {
  assert.equal(parseItermPid("12345 /Users/x/Apps/iTerm.app/Contents/MacOS/iTerm2"), 12345);
});

test("buildItermJxa binds app to the pid, never to a name", () => {
  const js = buildItermJxa(4242, "  return 'x';");
  assert.match(js, /var app = Application\(4242\);/);
  assert.match(js, /return 'x';/);
  assert.doesNotMatch(js, /Application\("/);
});

test("withSessionJxa quotes the id as a JS literal and returns the fallback", () => {
  const js = withSessionJxa('a"b\\c', '          return "hit";', '"miss"');
  assert.ok(js.includes(JSON.stringify('a"b\\c')));
  assert.match(js, /return "hit";/);
  assert.match(js, /return "miss";\s*$/);
});

test("cleanChildEnv drops iTerm's bundle id and keeps the rest", () => {
  const env = cleanChildEnv({ __CFBundleIdentifier: "com.googlecode.iterm2", PATH: "/bin" });
  assert.deepEqual(env, { PATH: "/bin" });
});

test("no source addresses iTerm by name, bundle id or path in AppleScript", () => {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts") && /tell application \\?"iTerm2\\?"|tell application id/.test(readFileSync(p, "utf8"))) hits.push(p);
    }
  };
  walk("src");
  assert.deepEqual(hits, []);
});
