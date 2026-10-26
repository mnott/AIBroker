import "./home-guard.js";
/**
 * test/manage-supervise.test.ts — a session supervising itself.
 *
 * Pins the pure parts: self resolution, until/every parsing, the idle nudge
 * (never over typed input), the handover target precedence, the minimum of
 * new work before another handover is asked for, and the status block.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveManageTarget, applySupervise, parseUntilSpec, parseEveryMin, nudgeDue, nextDueAt, statusLines,
  pickHandoverTarget, projectSinkDescription, handoverDue,
} from "../src/daemon/manage.js";
import type { ManagedSession } from "../src/daemon/manage.js";
import { resolveCallerPane } from "../src/daemon/core-handlers.js";
import type { IpcRequest } from "../src/types/ipc.js";
import type { SessionSnapshot } from "../src/adapters/iterm/core.js";

const NOW = new Date(2026, 9, 10, 22, 0, 0).getTime();

function sess(over: Partial<ManagedSession> = {}): ManagedSession {
  return {
    sessionId: "S1", name: "alpha", objective: "keep going", pending: [], history: [],
    lastRearmAt: NOW - 60 * 60_000, lastChangeAt: NOW - 40 * 60_000, lastHash: "", paused: false,
    startedAt: NOW - 3_600_000, ...over,
  };
}

const RULE = "─".repeat(40);
const pane = (input: string, marker = true) =>
  `${marker ? "◎ /goal active (3m)\n" : ""}● done\n${RULE}\n❯ ${input}\n${RULE}\n`;

// ── self resolution ──────────────────────────────────────────────────────────

test("omitted and 'self' resolve to the caller; a name stays; no caller is null", () => {
  assert.equal(resolveManageTarget(undefined, "UUID-1"), "UUID-1");
  assert.equal(resolveManageTarget("self", "UUID-1"), "UUID-1");
  assert.equal(resolveManageTarget(" SELF ", "UUID-1"), "UUID-1");
  assert.equal(resolveManageTarget("build", "UUID-1"), "build");
  assert.equal(resolveManageTarget("all", "UUID-1"), "all");
  assert.equal(resolveManageTarget("self", undefined), null);
});

// ── until / every ────────────────────────────────────────────────────────────

test("until takes a clock time (next occurrence) or a duration", () => {
  const now = new Date(NOW);
  const eight = parseUntilSpec("08:00", now)!;
  assert.equal(new Date(eight).getHours(), 8);
  assert.equal(new Date(eight).getDate(), 11); // 22:00 → tomorrow morning
  assert.equal(parseUntilSpec("until 11pm", now), new Date(2026, 9, 10, 23, 0, 0).getTime());
  assert.equal(parseUntilSpec("8h", now), NOW + 8 * 3_600_000);
  assert.equal(parseUntilSpec("90m", now), NOW + 90 * 60_000);
  assert.equal(parseUntilSpec("500h", now), NOW + 24 * 3_600_000); // capped like a shift
  assert.equal(parseUntilSpec("whenever", now), null);
});

test("every is minutes, '1h' works, out of range is refused", () => {
  assert.equal(parseEveryMin(30), 30);
  assert.equal(parseEveryMin("30m"), 30);
  assert.equal(parseEveryMin("1h"), 60);
  assert.equal(parseEveryMin(1), null);
  assert.equal(parseEveryMin("9999"), null);
  assert.equal(parseEveryMin("soon"), null);
});

// ── idle nudge ───────────────────────────────────────────────────────────────

test("nudge fires for an idle session with an empty input line and the marker shown", () => {
  const m = sess({ nudgeEveryMin: 30 });
  assert.equal(nudgeDue(m, pane(""), NOW), true);
});

test("nudge never fires over text on the input line", () => {
  const m = sess({ nudgeEveryMin: 30 });
  assert.equal(nudgeDue(m, pane("half a sentence"), NOW), false);
});

test("nudge waits for the interval, resets on a nudge, and is off without `every`", () => {
  assert.equal(nudgeDue(sess({ nudgeEveryMin: 60 }), pane(""), NOW), false); // idle only 40 min
  assert.equal(nudgeDue(sess({ nudgeEveryMin: 30, lastNudgeAt: NOW - 60_000 }), pane(""), NOW), false);
  assert.equal(nudgeDue(sess(), pane(""), NOW), false);
  assert.equal(nudgeDue(sess({ nudgeEveryMin: 30, paused: true }), pane(""), NOW), false);
});

test("a missing goal marker is the full re-arm's job, not a nudge", () => {
  assert.equal(nudgeDue(sess({ nudgeEveryMin: 30 }), pane("", false), NOW), false);
});

// ── handover target ──────────────────────────────────────────────────────────

test("handover target precedence: explicit > project sink > default", () => {
  const sink = "the forge issue";
  const all = { handoverFile: "/x/H.md", sinkDescription: sink, defaultPath: "/p/Notes/TODO.md" };
  assert.deepEqual(pickHandoverTarget(all), { path: "/x/H.md", source: "explicit" });
  assert.deepEqual(pickHandoverTarget({ ...all, handoverFile: undefined }), { description: sink, source: "project sink" });
  assert.deepEqual(pickHandoverTarget({ ...all, handoverFile: undefined, sinkDescription: null }), { path: "/p/Notes/TODO.md", source: "default" });
  assert.deepEqual(pickHandoverTarget({ sinkDescription: null, defaultPath: null }), { source: "none" });
});

test("project.yaml: forge sink is described, todo or absent is not", () => {
  const dir = mkdtempSync(join(tmpdir(), "sink-"));
  assert.equal(projectSinkDescription(dir), null);
  mkdirSync(join(dir, ".pai"));
  writeFileSync(join(dir, ".pai", "project.yaml"), "status:\n  sink: todo\n");
  assert.equal(projectSinkDescription(dir), null);
  writeFileSync(join(dir, ".pai", "project.yaml"), "status:\n  sink: forge\n  forge:\n    anchor: 283\n    marker: X\n    repo: OWNER/NAME\n");
  const sub = join(dir, "pkg");
  mkdirSync(sub);
  const d = projectSinkDescription(sub)!; // found walking up
  assert.match(d, /#283/);
  assert.match(d, /OWNER\/NAME/);
});

// ── no re-ask under the minimum of new work ──────────────────────────────────

test("no warm-up handover re-ask with under 20k of new work", () => {
  const base = { effectiveK: 800, idleMs: 10 * 60_000, now: NOW, lastAskAt: NOW - 3 * 3_600_000, handoverDoneK: 750 };
  // 753k: warm-up band by time (3h since), but only 3k new work.
  assert.equal(handoverDue({ ...base, contextK: 753 }).due, false);
  assert.match(handoverDue({ ...base, contextK: 753 }).reason, /only 3k/);
  // The immediate band stays ungated by design.
  assert.equal(handoverDue({ ...base, contextK: 790, handoverDoneK: 788 }).due, true);
  // Enough new work and time: asks again.
  assert.equal(handoverDue({ ...base, contextK: 770 }).due, true);
  // Never handed over: unaffected.
  assert.equal(handoverDue({ ...base, contextK: 753, handoverDoneK: undefined, lastAskAt: undefined }).due, true);
});

// ── status view ──────────────────────────────────────────────────────────────

test("status lists every session: name, goal, until, next due, context, handover, state", () => {
  const long = "x".repeat(200);
  const lines = statusLines(
    [
      sess({ objective: long, nudgeEveryMin: 30, shift: { until: new Date(2026, 9, 11, 8, 0).getTime(), workers: 1, visual: false, startedAt: NOW, plain: true }, handoverDoneAt: new Date(2026, 9, 10, 21, 5).getTime() }),
      sess({ name: "beta", paused: true }),
    ],
    NOW,
    (m) => (m.name === "alpha" ? 410 : null),
  );
  assert.equal(lines.length, 2);
  const [a, b] = lines;
  assert.match(a, /^alpha \| goal: x{79}… \| until: 08:00 \| next nudge: due \| ctx: 41% 410k \| handover: 21:05 \| supervised$/);
  assert.match(b, /^beta \| goal: keep going \| until: - \| next arm: - \| ctx: \? \| handover: - \| paused$/);
  assert.deepEqual(statusLines([], NOW), ["no sessions are being managed"]);
});

test("next due: nudge counts from the latest of change/nudge/arm; plain sessions use the lapse ceiling", () => {
  assert.equal(nextDueAt(sess({ nudgeEveryMin: 30 })), NOW - 40 * 60_000 + 30 * 60_000);
  assert.equal(nextDueAt(sess()), NOW - 60 * 60_000 + 45 * 60_000);
});

// ── supervise on a fresh entry ───────────────────────────────────────────────

test("supervise on a fresh entry sets goal/until/every and does not grant the screen", () => {
  const m = sess({ objective: "start", nudgeEveryMin: undefined });
  applySupervise(m, "hold the line", NOW + 3_600_000, 30);
  assert.equal(m.objective, "hold the line");
  assert.equal(m.nudgeEveryMin, 30);
  assert.equal(m.shift?.until, NOW + 3_600_000);
  assert.equal(m.shift?.visual, false);
  assert.equal(m.paused, false);
});

// ── caller pane (manage self) ────────────────────────────────────────────────

const snap = (over: Record<string, unknown>) => ({ name: "", isClaude: true, ...over }) as unknown as SessionSnapshot;
const attachPane = snap({ id: "LIVE-PANE", attachUuid: "cdd93e8d" });
const shell = snap({ id: "SHELL", isClaude: false });

test("self with a dead iTerm id and a session uuid resolves to the attach pane", () => {
  const req = { itermSessionId: "w0t0p0:DEAD-ID", claudeSessionId: "cdd93e8d-1111-2222-3333-444455556666" } as IpcRequest;
  const pane = resolveCallerPane(req, [shell, attachPane]);
  assert.equal(pane?.id, "LIVE-PANE");
  assert.equal(resolveManageTarget("self", pane?.id), "LIVE-PANE");
});

test("self in the normal case stays the caller's own pane", () => {
  const own = snap({ id: "OWN" });
  const req = { itermSessionId: "w0t0p0:OWN", claudeSessionId: "cdd93e8d-1111-2222-3333-444455556666" } as IpcRequest;
  assert.equal(resolveCallerPane(req, [own, attachPane])?.id, "OWN");
  assert.equal(resolveCallerPane({ itermSessionId: "OWN" } as IpcRequest, [own, attachPane])?.id, "OWN");
});
