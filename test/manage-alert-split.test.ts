import "./home-guard.js";
/**
 * test/manage-alert-split.test.ts — the operator hears ONLY what needs their
 * attention; routine handover steps are logged and not buzzed.
 *
 * Observed live 2026-10-24 17:08: writing a handover put messages on PAILot —
 * "at Nk tokens … asked for a handover", "handover written — asking it to
 * clear", "the clear … has landed — arming the fresh session". Those are
 * routine steps of the job the manager was told to run; the operator's own
 * report carries their count. What still earns a buzz is what needs the
 * operator to act or to know something went wrong: a session exited to a
 * shell, a goal that never took, a demanded arm their own text is holding,
 * a handover asked for and never produced, a screen that has not moved for
 * an hour, a grant they are being asked to renew.
 *
 * The split is one helper each — `logOnly` (history + log) versus `alert`
 * (the same plus the phone) — and these tests pin which side each path
 * landed on, with the phone spied through the bridge the alert routes out
 * over.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

// The brief the goal line points at is written into the (sandboxed) home.
mkdirSync(join(homedir(), ".aibroker", "manage-briefs"), { recursive: true, mode: 0o700 });

// ── the phone, spied ─────────────────────────────────────────────────────
//
// `alertOperator` reaches the operator through the bridge in core/state;
// everything else in the gateway is stubbed off, so a buzz that arrives
// here is a buzz that left the manager, and one that does not is one that
// stayed in the log.
const buzzes: string[] = [];

const realState = await import("../src/core/state.js");
mock.module("../src/core/state.js", {
  namedExports: {
    ...realState,
    getAibpBridge: () => ({ routeToMobile: (_id: string, text: string) => { buzzes.push(text); } }),
  },
});
const realGateway = await import("../src/adapters/pailot/gateway.js");
mock.module("../src/adapters/pailot/gateway.js", {
  namedExports: { ...realGateway, hasPailotClients: () => true },
});

// One model of the pane, moved by the typing primitives the way a real pane
// moves — nothing here touches a terminal.
let inputLine = "";
let markerUp = false;
let bannerUp = false;
let atPrompt = false;
let paneName = "CaseLeaf";
let pasteOk = true;
let pastes = 0;
let enters = 0;
/** Whether Enter brings the goal marker back — false pins "typed, never landed". */
let landed = true;
let typed: string[] = [];
const reset = () => {
  inputLine = "";
  markerUp = false;
  bannerUp = false;
  landed = true;
  atPrompt = false;
  paneName = "CaseLeaf";
  pasteOk = true;
  pastes = 0;
  enters = 0;
  typed = [];
  buzzes.length = 0;
};

const realFacade = await import("../src/transport/sync-facade.js");
mock.module("../src/transport/sync-facade.js", {
  namedExports: {
    ...realFacade,
    pasteTextIntoSession: (_id: string, text: string) => {
      if (!pasteOk) return false;
      pastes++;
      inputLine = text;
      return true;
    },
    sendControlU: () => { inputLine = ""; return true; },
    sendEnterKey: () => { enters++; inputLine = ""; markerUp = landed; return true; },
    escapeInputMode: () => {},
    typeIntoSession: (_id: string, text: string) => { typed.push(text); return true; },
    wasLastEnumerationReliable: () => true,
  },
});

const realContent = await import("../src/daemon/session-content.js");
mock.module("../src/daemon/session-content.js", {
  namedExports: {
    ...realContent,
    readSessionContentAsync: async () => ({
      sessionId: "s",
      name: paneName,
      content: paneScreen(),
      lineCount: 8,
      atPrompt,
      paiName: paneName,
    }),
  },
});

const RULE = "─".repeat(40);
function paneScreen(): string {
  return [
    bannerUp ? "Claude Code v0.62.5 · fresh session" : "a wall of work",
    markerUp ? "◎ /goal active (3m)" : "● done",
    RULE,
    `❯ ${inputLine}`,
    RULE,
  ].join("\n");
}

const M = await import("../src/daemon/manage.js");
const NOW = Date.now();

const entry = (over = {}) =>
  ({
    sessionId: "s",
    name: "CaseLeaf",
    objective: "keep the tests green",
    pending: [],
    history: [],
    lastRearmAt: NOW - 600_000,
    lastChangeAt: NOW - 30_000,
    lastHash: "",
    paused: false,
    startedAt: NOW - 3_600_000,
    ...over,
  }) as import("../src/daemon/manage.js").ManagedSession;

const said = (m: { history: { what: string }[] }, needle: string) =>
  m.history.some((h) => h.what.includes(needle));

// ── the handover paths: logged, never buzzed ─────────────────────────────

test("an arming is routine: logged, the phone stays quiet", async () => {
  reset();
  const m = entry({ lastRearmAt: 0 });
  const r = await M.arm(m, M.FORCED_ARM_REASON);
  assert.equal(r, "armed");
  assert.equal(buzzes.length, 0, "an arming is routine — no buzz");
  assert.ok(said(m, "armed"), "the record still carries it");
});

test("handover written, left to compact: logged, the phone stays quiet", async () => {
  reset();
  const path = join(homedir(), ".aibroker", "handover-pin.md");
  writeFileSync(path, "old\n");
  const m = entry({
    handoverFile: path,
    clearAfterHandover: false,
    handoverAskedAt: NOW - 60_000,
    handoverWas: "0:0",
    handoverAskedPath: path,
  });
  await M.runTickForTest(NOW, m);
  assert.ok(said(m, "handover written — leaving the session to compact"), "logged");
  assert.equal(buzzes.length, 0, "a handover landing is routine — no buzz");
});

test("handover written, clear asked for: logged, the phone stays quiet", async () => {
  reset();
  const path = join(homedir(), ".aibroker", "handover-pin-clear.md");
  writeFileSync(path, "old\n");
  const m = entry({
    handoverFile: path,
    clearAfterHandover: true,
    handoverAskedAt: NOW - 60_000,
    handoverWas: "0:0",
    handoverAskedPath: path,
  });
  await M.runTickForTest(NOW, m);
  assert.ok(said(m, "handover written — asking it to clear"), "logged");
  assert.equal(typed.filter((t) => t === "/clear").length, 1, "the clear was typed");
  assert.equal(buzzes.length, 0, "asking for the clear is routine — no buzz");
});

test("the clear landed late: logged, the phone stays quiet", async () => {
  reset();
  bannerUp = true;
  const m = entry({ clearPendingSince: NOW - 10 * 60_000 });
  await M.runTickForTest(NOW, m);
  assert.ok(said(m, "has landed — arming the fresh session"), "logged");
  assert.equal(buzzes.length, 0, "a clear landing is routine — no buzz");
});

// ── what still needs the operator's attention ────────────────────────────

test("the session exited to a shell prompt: PAUSED still buzzes", async () => {
  reset();
  atPrompt = true;
  paneName = "-zsh";
  const m = entry({ lastRearmAt: 0 });
  const r = await M.arm(m, M.FORCED_ARM_REASON);
  assert.equal(r, "failed");
  assert.equal(m.paused, true);
  assert.equal(buzzes.length, 1, "an exited session needs attention");
  assert.match(buzzes[0], /PAUSED — that pane is at a shell prompt/);
});

test("a handover asked for and never produced: still buzzes", async () => {
  reset();
  const m = entry({ handoverAskedAt: NOW - 40 * 60_000 });
  await M.runTickForTest(NOW, m);
  assert.ok(said(m, "asked for a handover and did not get one"), "logged");
  assert.equal(buzzes.length, 1, "a handover that never came needs attention");
  assert.match(buzzes[0], /asked for a handover and did not get one/);
});

test("a demanded arm held by the operator's own text: still buzzes", async () => {
  reset();
  inputLine = "half a sentence the operator is still typing";
  const m = entry({ lastRearmAt: 0 });
  const r = await M.arm(m, M.FORCED_ARM_REASON);
  assert.equal(r, "skipped");
  assert.equal(pastes, 0, "never typed over the operator's line");
  assert.equal(buzzes.length, 1, "the operator has something to do about their line");
  assert.match(buzzes[0], /demanded arm .* is NOT being typed/);
});

test("a goal typed that never took: still buzzes", async () => {
  reset();
  // The faithful model of "typed but never landed": the paste lands and the
  // line echoes it, Enter fires, and the marker stays down — sendEnterKey
  // raises it only while the pane model says the goal actually took.
  landed = false;
  const m = entry({ lastRearmAt: 0 });
  const r = await M.arm(m, M.FORCED_ARM_REASON);
  assert.equal(r, "failed");
  assert.equal(pastes, 1, "it was typed");
  assert.ok(said(m, "the goal never took"), "logged");
  assert.equal(buzzes.length, 1, "a goal that would not land needs attention");
  assert.match(buzzes[0], /the goal never took/);
});
