import "./home-guard.js";
/**
 * test/manage-goal-line-pure.test.ts — the ceiling must not rewrite the brief.
 *
 * `goalText` is not pure: every call rewrites ~/.aibroker/manage-briefs/<slug>.md
 * (writeFileSync + chmod 0600, consuming m.pending notes into the brief). The
 * ceiling runs on every quiet tick past the 46-min mark and used to call it to
 * derive the expected goal line — so a read-only check mutated state every tick.
 * `goalLineFor` is the pure half: same builder, no disk. This pins that
 * separation: goalLineFor leaves the brief untouched, and goalText's text still
 * equals goalLineFor (expected and typed cannot drift).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { goalLineFor, goalText, briefSlug, reasonToArm, type ManagedSession } from "../src/daemon/manage.js";

const BRIEF = join(process.env.HOME ?? "", ".aibroker", "manage-briefs");

function base(): ManagedSession {
  return {
    sessionId: "pure-1",
    name: "pure-one",
    objective: "Audit every module and fix the drift.",
    pending: ["note one", "note two"],
    history: [],
    lastRearmAt: Date.now(),
    lastChangeAt: Date.now(),
    lastHash: "h",
    paused: false,
  };
}

function briefPath(m: ManagedSession): string {
  return join(BRIEF, `${briefSlug(m)}.md`);
}

test("goalLineFor does not create the brief file", () => {
  const m = base();
  assert.ok(!existsSync(briefPath(m)));
  goalLineFor(m);
  assert.ok(!existsSync(briefPath(m)), "goalLineFor must not write the brief");
});

test("goalLineFor does not modify an existing brief (content, mtime, mode)", () => {
  const m = base();
  // Arm once so the brief exists with pending notes consumed.
  goalText(m);
  const p = briefPath(m);
  const before = readFileSync(p, "utf8");
  const st = statSync(p);
  // A pending note that goalText WOULD consume into the brief: if goalLineFor
  // still wrote, the file would change. mtime is coarse on some filesystems, so
  // it is only asserted when it is distinguishable from a fresh write.
  m.pending = ["a fresh operator note"];
  const mtDistinguishable = st.mtimeMs < Date.now() - 100;
  goalLineFor(m);
  assert.equal(readFileSync(p, "utf8"), before, "goalLineFor must not rewrite the brief");
  const after = statSync(p);
  if (mtDistinguishable) assert.equal(after.mtimeMs, st.mtimeMs, "mtime must not move");
  assert.equal(after.mode & 0o777, st.mode & 0o777, "mode must not change");
});

test("goalLineFor equals goalText's text (expected and typed cannot drift)", () => {
  const m = base();
  m.shift = { until: Date.now() + 60 * 60_000, startedAt: Date.now() - 5 * 60_000 } as ManagedSession["shift"];
  assert.equal(goalLineFor(m), goalText(m).text);

  // A shift-less session too — the prefix differs, both must still agree.
  const m2 = base();
  assert.equal(goalLineFor(m2), goalText(m2).text);

  // After arming (brief rewritten, pending consumed) they still agree.
  assert.equal(goalLineFor(base()), goalText(base()).text);
});

test("ceiling path: reasonToArm past the ceiling leaves the brief untouched", () => {
  const m = base();
  // Distinct identity so this suite's brief never collides with another test's.
  m.sessionId = "pure-ceiling-9";
  m.name = "pure-ceiling-nine";
  const dir = mkdtempSync(join(tmpdir(), "aibroker-pure-ceiling-"));
  try {
    const file = join(dir, "s1.jsonl");
    // A transcript with no goal at all — the ceiling takes its full path and
    // would have rewritten the brief via goalText before this fix.
    writeFileSync(file, JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "working" }] } }) + "\n");

    m.transcriptFile = file;
    // The ceiling needs the goal marker present in the pane (reasonToArm's
    // "no goal armed" branch fires otherwise); same fixture as manage-goal-active.
    const ACTIVE_PANE = "/goal active\n❯ ";
    const now = Date.now();
    m.lastRearmAt = now - 46 * 60_000;
    m.lastChangeAt = now - 40_000;

    // No brief yet: the ceiling must not create one (goalText would mkdir + write).
    assert.ok(!existsSync(briefPath(m)));
    const r = reasonToArm(m, ACTIVE_PANE, now);
    assert.match(r ?? "", /assuming it lapsed/);
    assert.ok(!existsSync(briefPath(m)), "the ceiling must not create the brief");

    // With a brief: content and mtime must survive a ceiling tick.
    goalText(m);
    const p = briefPath(m);
    const before = readFileSync(p, "utf8");
    const mt = statSync(p).mtimeMs;
    reasonToArm(m, ACTIVE_PANE, now + 10_000);
    assert.equal(readFileSync(p, "utf8"), before, "the ceiling must not rewrite the brief");
    assert.equal(statSync(p).mtimeMs, mt, "the ceiling must not touch the brief's mtime");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
