import "./home-guard.js";
/**
 * test/manage-clear-line.test.ts — a clear that is not verified is not a clear.
 *
 * Observed live 2026-10-20 04:25 (CaseLeaf, iTerm 0A1A0BFE): the session's CLI
 * defers keystrokes mid-turn, so sendControlU cleared nothing — but arm()
 * pasted anyway after the unverified clear. The line still held its text, so
 * inputLineDecision re-ordered clear-then-type every ghost window, each cycle
 * appending another /goal paste: ~7 concatenated unsent lines piled onto the
 * input buffer over two minutes, to submit as one giant broken line at the
 * turn boundary, and every message to the session queued behind the pile.
 *
 * These tests pin the four repairs: the clear is verified by reading the line
 * back and a failed clear pastes nothing (skipped — no streak, no sentinel
 * loss); the same verify-empty rule sits immediately before every paste,
 * including the busy-queued arm; a failed clear escalates inputLineDecision to
 * "stop" until the line observably empties on its own; and `manage <session>
 * clear-line` is the manual lever that verifies between attempts and reports
 * what remains.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

mkdirSync(join(homedir(), ".aibroker", "manage-briefs"), { recursive: true, mode: 0o700 });

// One model of the pane, moved by the typing primitives the way a real pane
// moves. `ctrlUWorksFrom` models a CLI that defers keystrokes: sends before
// that number land nowhere (the 04:25 failure), later ones clear.
let inputLine = "";
let markerUp = false;
let pasteOk = true;
let pastes = 0;
let enters = 0;
let ctrlUs = 0;
let ctrlUWorksFrom = 1;
// When set, the FIRST pane reads come from this script (one per
// readSessionContentAsync call) — for text that materialises between two
// reads. Once spent, the live model takes over.
let paneScript: string[] | null = null;

const reset = () => {
  inputLine = "";
  markerUp = false;
  pasteOk = true;
  pastes = 0;
  enters = 0;
  ctrlUs = 0;
  ctrlUWorksFrom = 1;
  paneScript = null;
};

const realFacade = await import("../src/transport/sync-facade.js");
const realContent = await import("../src/daemon/session-content.js");
const realDiscovery = await import("../src/core/session-discovery.js");

mock.module("../src/transport/sync-facade.js", {
  namedExports: {
    ...realFacade,
    pasteTextIntoSession: (_id: string, text: string) => {
      if (!pasteOk) return false;
      pastes++;
      inputLine = text;
      return true;
    },
    sendControlU: () => {
      ctrlUs++;
      if (ctrlUs >= ctrlUWorksFrom) inputLine = "";
      return true;
    },
    sendEnterKey: () => {
      enters++;
      inputLine = "";
      markerUp = true;
      return true;
    },
    escapeInputMode: () => {},
    typeIntoSession: () => true,
    wasLastEnumerationReliable: () => true,
  },
});

const RULE = "─".repeat(40);
function paneScreen(): string {
  return `${markerUp ? "◎ /goal active (3m)\n" : ""}● done\n${RULE}\n❯ ${inputLine}\n${RULE}\n`;
}
function scriptedPane(): string {
  if (paneScript && paneScript.length > 0) return paneScript.shift()!;
  return paneScreen();
}

mock.module("../src/daemon/session-content.js", {
  namedExports: {
    ...realContent,
    readSessionContent: (() => ({ content: scriptedPane(), name: "CaseLeaf (claude)", atPrompt: false })) as never,
    readSessionContentAsync: async () => ({
      sessionId: "s",
      name: "CaseLeaf",
      content: scriptedPane(),
      lineCount: 6,
      atPrompt: false,
      paiName: "CaseLeaf",
    }),
  },
});

const SID = "clrl-1111";
const SID_UNMANAGED = "clrl-2222";
mock.module("../src/core/session-discovery.js", {
  namedExports: {
    ...realDiscovery,
    discoverLiveSessions: () => [
      { id: SID, aibrokerId: SID, name: "ClearLine", paiName: "ClearLine" },
      { id: SID_UNMANAGED, aibrokerId: SID_UNMANAGED, name: "Other", paiName: "Other" },
    ],
  },
});
mock.module("../src/daemon/peer-handlers.js", { namedExports: { forwardToPeer: async () => null } });

const M = await import("../src/daemon/manage.js");

const NOW = Date.now();
// Idle long enough for armIdle, so the ghost window can open (HANDOVER_IDLE_FLOOR_MS).
const entry = (sessionId: string, over = {}) =>
  ({
    sessionId,
    name: "CaseLeaf",
    objective: "x",
    pending: [],
    history: [],
    lastRearmAt: NOW - 600_000,
    lastChangeAt: NOW - 300_000,
    lastHash: "",
    paused: false,
    startedAt: NOW - 3_600_000,
    ...over,
  }) as import("../src/daemon/manage.js").ManagedSession;

// The pile from the log: ~1171 chars of concatenated unsent /goal pastes.
const PILE = "/goal supervise the queue until 08:00 and report. ".repeat(24).trim();

const clearNotes = (m: { history: { what: string }[] }) => m.history.filter((h) => h.what.startsWith("clear did not take"));
const handsOffNotes = (m: { history: { what: string }[] }) => m.history.filter((h) => h.what.includes("hands off the input line"));

test("clear fails (Ctrl-U lands nowhere) → no paste, skipped, loud note, no streak, sentinel intact", async () => {
  reset();
  ctrlUWorksFrom = 99; // the CLI defers every keystroke: nothing ever clears
  inputLine = PILE;
  const m = entry("s1", { armFailStreak: 2, armFails: 1 });

  // Feed the ghost window: identical text, idle, tick after tick.
  let result: M.ArmResult = "skipped";
  for (let i = 0; i < 6; i++) result = await M.arm(m, M.GOAL_GONE_REASON);
  assert.equal(result, "skipped", "the 6th tick orders the clear and must not paste");
  assert.equal(pastes, 0, "nothing pasted onto a line the clear did not empty");
  assert.equal(enters, 0);
  assert.equal(ctrlUs, M.CLEAR_VERIFY_ATTEMPTS, "three verified attempts, then hands off");
  assert.match(
    clearNotes(m)[0]?.what ?? "",
    new RegExp(`clear did not take — ${PILE.length} chars survive Ctrl-U; not pasting, not feeding the pile`),
  );

  // A skip is not a failure: no streak, no sentinel loss.
  assert.equal(m.armFailStreak, 2);
  assert.equal(m.armFails, 1);
  assert.equal(m.lastRearmAt, NOW - 600_000, "the arm-now sentinel is untouched");
  assert.equal(m.stuckSince, undefined);

  // The next cycle must NOT re-order clear-then-type: no new Ctrl-U, no paste.
  // It hits the stop state the same second as the loud note, so both notes are
  // deduped — one episode, one note.
  const before = ctrlUs;
  assert.equal(await M.arm(m, M.GOAL_GONE_REASON), "skipped");
  assert.equal(ctrlUs, before, "hands off — not clearing again");
  assert.equal(pastes, 0, "hands off — not typing either");
  assert.equal(handsOffNotes(m).length, 0, "still inside the loud note's dedup window");
  assert.equal(clearNotes(m).length, 1, "the loud note dedups across the hands-off cycles");

  // Outside the dedup window, the hands-off state says why the arm is waiting.
  m.clearFailedNotedAt = Date.now() - M.CLEAR_RETRY_NOTE_MS - 1_000;
  assert.equal(await M.arm(m, M.GOAL_GONE_REASON), "skipped");
  assert.equal(handsOffNotes(m).length, 1);
  assert.equal(ctrlUs, before, "and still nothing is sent");
  assert.equal(await M.arm(m, M.GOAL_GONE_REASON), "skipped");
  assert.equal(handsOffNotes(m).length, 1, "deduped again for 10 minutes");

  // The line empties on its own (the turn boundary submitted it): the arm goes
  // out normally, with no further clearing.
  inputLine = "";
  const armed = await M.arm(m, M.GOAL_GONE_REASON);
  assert.equal(armed, "armed");
  assert.equal(pastes, 1);
  assert.equal(enters, 1);
  assert.equal(ctrlUs, before, "no clear was needed once the line read back empty");
});

test("clear succeeds on attempt 2 → paste proceeds into the verified-empty line", async () => {
  reset();
  ctrlUWorksFrom = 2; // first Ctrl-U deferred, the session starts reading keystrokes
  inputLine = PILE;
  const m = entry("s2");

  let result: M.ArmResult = "skipped";
  for (let i = 0; i < 6; i++) result = await M.arm(m, M.GOAL_GONE_REASON);
  assert.equal(result, "armed", "the verified clear opened the line and the arm went out");
  assert.equal(ctrlUs, 2, "verified between attempts: one retry, then the read-back came back empty");
  assert.equal(pastes, 1);
  assert.equal(enters, 1);
  assert.equal(clearNotes(m).length, 0, "no failure was claimed");
  assert.equal(m.history.filter((h) => h.what.startsWith("clearing persistent input-line text")).length, 1);
  assert.ok(m.lastRearmAt > 0);
});

test("inputLineDecision: a failed clear answers stop until the text is gone", () => {
  // Escalated: even a full ghost window while idle must not order another clear.
  assert.equal(
    M.inputLineDecision({ text: PILE, sameForTicks: 9, idle: true, idleMs: 300_000, clearFailed: true }).action,
    "stop",
  );
  // The escalation is not about this exact text: a changed line is still not an empty one.
  assert.equal(M.inputLineDecision({ text: "someone typed more", sameForTicks: 1, idle: true, clearFailed: true }).action, "stop");
  // Lifted only by an empty read.
  assert.equal(M.inputLineDecision({ text: "", sameForTicks: 9, idle: true, clearFailed: true }).action, "type");
  // Without the escalation the old policy stands unchanged.
  assert.equal(M.inputLineDecision({ text: PILE, sameForTicks: 6, idle: true }).action, "clear-then-type");
  assert.equal(M.inputLineDecision({ text: PILE, sameForTicks: 6, idle: false }).action, "skip");
});

test("busy-queued arm with a line that fills between the reads → no paste, existing guards intact", async () => {
  reset();
  // The decision reads see an empty line; by the paste the deferred keystrokes
  // have rendered and the line holds text — exactly the window the 04:25 pile
  // was built through.
  paneScript = [paneScreen(), paneScreen()];
  inputLine = "late-arriving queued text";
  const m = entry("s3", { lastChangeAt: NOW - 30_000, armFailStreak: 4, armFails: 2 });

  const result = await M.arm(m, M.GOAL_GONE_BUSY_REASON);
  assert.equal(result, "skipped");
  assert.equal(pastes, 0, "paste only into a line that just read back empty");
  assert.equal(enters, 0);
  assert.equal(ctrlUs, 0, "no clear was ordered — the line only now shows text");
  assert.ok(m.history.some((h) => h.what.includes("chars just before typing")), JSON.stringify(m.history));
  assert.equal(m.armFailStreak, 4, "a skip is not a failure, as before");
  assert.equal(m.armFails, 2);
  assert.equal(m.lastRearmAt, NOW - 600_000, "no sentinel loss, as before");

  // The same busy-queued arm with a line that genuinely reads empty still
  // pastes — the guard must not hold back a legitimate queue-behind-the-turn.
  reset();
  const busy = entry("s3b", { lastChangeAt: NOW - 30_000 });
  assert.equal(await M.arm(busy, M.GOAL_FORCED_BUSY_REASON), "armed");
  assert.equal(pastes, 1);
  assert.equal(enters, 1);
});

test("clear-line CLI: verifies between attempts, reports the state, creates no manager", async () => {
  reset();
  inputLine = "unsent text on the line";
  const first = await M.handleManage(SID, "clear-line");
  assert.ok(first.ok, first.message);
  assert.match(first.message, /ClearLine: input line is empty after Ctrl-U ×1/);
  assert.equal(ctrlUs, 1, "one attempt was enough, verified by the read-back");
  assert.equal(inputLine, "");
  assert.equal(first.managed, false, "the session was not being managed");

  reset();
  const second = await M.handleManage(SID, "clear-line");
  assert.ok(second.ok, second.message);
  assert.match(second.message, /already clear/);
  assert.equal(ctrlUs, 0, "an empty line is verified before anything is sent");

  reset();
  ctrlUWorksFrom = 99;
  inputLine = "half a sentence by the operator";
  const stuck = await M.handleManage(SID, "clear-line");
  assert.equal(stuck.ok, false, "a clear that did not take is reported as not taken");
  assert.match(stuck.message, /clear did not take — 31 chars still on the input line after Ctrl-U ×3/);
  assert.equal(ctrlUs, 3);

  // A live but unmanaged session is answered too — the lever is not
  // manager-gated — and still creates nothing.
  reset();
  inputLine = "junk";
  const other = await M.handleManage(SID_UNMANAGED, "clear-line");
  assert.ok(other.ok, other.message);
  assert.equal(Object.keys(M.loadState()).length, 0, "no manager was created by the lever");

  // Unknown session: refused. (The CLI exits 1 on this the same way it does
  // for every manage refusal: core-handlers maps ok:false to an IPC error and
  // the manage verb sets process.exitCode = 1.)
  reset();
  const ghost = await M.handleManage("no-such-pane", "clear-line");
  assert.equal(ghost.ok, false);
  assert.match(ghost.message, /no live session matches/);
});

test("clear-line is in manage's help, and plain text still becomes an objective (guard against keyword drift)", async () => {
  reset();
  const help = await M.handleManage(SID, "help");
  assert.ok(help.ok);
  assert.match(help.message, /clear-line/);
  await M.handleManage(SID, "off");
});
