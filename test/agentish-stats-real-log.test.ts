/**
 * test/agentish-stats-real-log.test.ts — proof against the real log, not a
 * fixture built to make a point.
 *
 * The bug this guards against: an earlier version of the target filter
 * required `session:` on both sides of a send, matched 0 of 1366 real events
 * in `~/.aibroker/audit.jsonl`, and printed "no data" — an instrument
 * measuring nothing while reporting clean. A synthetic fixture cannot catch
 * that failure, because whoever writes the fixture also writes it to match
 * whatever the filter currently does. This file deliberately does NOT set
 * `AIBROKER_AUDIT_FILE`, so `agentishStats()` reads whatever `homedir()`
 * resolves to — and skips instead of failing where no log is there to read,
 * since absence is not the fault this test exists to catch.
 *
 * Under `npm test`, that is always: `test/home-guard.ts` fakes HOME for
 * every test, on purpose and for good reason (see its own header), so this
 * test always skips in the normal run and that is correct, not a bug in it.
 * It exists for a person to run directly —
 * `npx tsx test/agentish-stats-real-log.test.ts` outside the guarded
 * harness, or `node --test` with `--import` omitted — as the manual check
 * the fix this file documents was actually verified against.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REAL_LOG = join(homedir(), ".aibroker", "audit.jsonl");

test(
  "stats-real-log-nonzero+ agentishStats sees real session-to-session traffic on this machine's own audit log",
  { skip: !existsSync(REAL_LOG) },
  async () => {
    const { agentishStats, formatStatsReport } = await import("../src/daemon/agentish-stats.js");
    const r = agentishStats();
    const total = r.ag2.count + r.prose.count;
    assert.ok(
      total > 0,
      `expected nonzero session-to-session sends on ${REAL_LOG}, got 0 — the actor/target filter may be broken again\n${formatStatsReport(r)}`,
    );
  },
);
