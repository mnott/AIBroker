import "./home-guard.js";
/**
 * test/iterm-bundle-id-impostor.test.ts — pins the lsappinfo parser that
 * names a process registered under iTerm2's bundle id from a different
 * executable (see src/adapters/iterm/core.ts: findItermBundleIdImpostors).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLsappinfoImpostors } from "../src/adapters/iterm/core.js";

const REAL_ONLY = `1) "iTerm2" ASN:0x0-0x1000: (in front)
    bundleID="com.googlecode.iterm2"
    bundle path="/Applications/iTerm.app"
    executable path="/Applications/iTerm.app/Contents/MacOS/iTerm2"
    pid = 1000 token=[sess=1 pid=1000] type="Foreground"
    launch time =  2026/01/01 00:00:00
2) "Finder" ASN:0x0-0x1001:
    bundleID="com.apple.finder"
    bundle path="/System/Library/CoreServices/Finder.app"
    executable path="/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder"
    pid = 1001 type="Foreground"
`;

const WITH_IMPOSTOR = `${REAL_ONLY}3) "osascript" ASN:0x0-0x1002:
    bundleID="com.googlecode.iterm2"
    bundle path="/usr/bin/osascript"
    executable path="/usr/bin/osascript"
    pid = 2000 type="BackgroundOnly"
`;

test("real iTerm2 entry alone yields no impostors", () => {
  assert.deepEqual(parseLsappinfoImpostors(REAL_ONLY), []);
});

test("a process under iTerm's bundle id but a different executable is named", () => {
  assert.deepEqual(parseLsappinfoImpostors(WITH_IMPOSTOR), [
    { pid: 2000, executablePath: "/usr/bin/osascript" },
  ]);
});

test("right-aligned entries: a non-first single-digit entry with iTerm's bundle id is correctly identified", () => {
  const rightAligned = ` 1) "Finder" ASN:0x0-0x1001:
    bundleID="com.apple.finder"
    bundle path="/System/Library/CoreServices/Finder.app"
    executable path="/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder"
    pid = 1001 type="Foreground"
 2) "Something" ASN:0x0-0x1002:
    bundleID="com.something"
    bundle path="/Applications/Something.app"
    executable path="/Applications/Something.app/Contents/MacOS/Something"
    pid = 1002 type="BackgroundOnly"
 3) "osascript" ASN:0x0-0x1003:
    bundleID="com.googlecode.iterm2"
    bundle path="/usr/bin/osascript"
    executable path="/usr/bin/osascript"
    pid = 2000 type="BackgroundOnly"
`;
  assert.deepEqual(parseLsappinfoImpostors(rightAligned), [
    { pid: 2000, executablePath: "/usr/bin/osascript" },
  ]);
});
