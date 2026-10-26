import "./home-guard.js";
/**
 * test/session-discovery-reliability.test.ts — an unreadable iTerm must not
 * read as an empty machine.
 *
 * Observed live: osascript -1708 makes snapshotAllSessions() return `[]`,
 * indistinguishable from a genuinely empty machine, for every caller of
 * discoverLiveSessions() — not just HybridManager, which already had its own
 * guard. This pins the shared guard: a good enumeration is remembered, and a
 * subsequent failed one replays it instead of the raw `[]`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { _internal, invalidateSnapshotCache } = await import("../src/adapters/iterm/core.js");
const { discoverLiveSessions } = await import("../src/core/session-discovery.js");

const row = (id: string, proc: string, tty: string, title: string) =>
  [id, proc, tty, title].join("\t");

function stubEnumeration(lines: string[] | null) {
  const original = _internal.runItermJxa;
  _internal.runItermJxa = (script: string) =>
    script.includes("tab.title") ? (lines ? lines.join("\n") : null) : null;
  return { restore: () => { _internal.runItermJxa = original; } };
}

test("a failed enumeration replays the last good list instead of []", () => {
  const id = "AAAAAAAA-0000-4000-8000-00000000A001";

  invalidateSnapshotCache();
  let stub = stubEnumeration([row(id, "claude (node)", "/dev/ttys001", "Session One")]);
  const good = discoverLiveSessions({ fresh: true });
  stub.restore();
  assert.equal(good.length, 1, "reliable enumeration must return the live session");
  assert.equal(good[0].id, id);

  invalidateSnapshotCache();
  stub = stubEnumeration(null);
  const afterFailure = discoverLiveSessions({ fresh: true });
  stub.restore();
  assert.equal(afterFailure.length, 1, "a failed enumeration must keep the known session, not report []");
  assert.equal(afterFailure[0].id, id);
});
