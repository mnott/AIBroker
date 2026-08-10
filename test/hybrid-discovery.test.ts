/**
 * test/hybrid-discovery.test.ts — the session list may not answer "none"
 * without having looked.
 *
 * The defect this pins: the registry was populated only by whoever happened to
 * register a session, so a channel asking before anything had done so was told
 * "No sessions." — the same words an empty machine uses, from a list that had
 * never been filled. Meanwhile the MCP tool enumerated live tabs and saw eight.
 *
 * The three states below are deliberately distinct, because the evening this
 * came from was spent on systems that reported a state they had not verified.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { HybridSessionManager } from "../src/core/hybrid.js";

const backend = { createSession: () => ({ id: "api-1" }), activeSessionId: "" } as never;
const tab = (id: string, name: string) => ({ id, name, paiName: name, tabTitle: name });

test("a list is discovered, not waited for", () => {
  const m = new HybridSessionManager(backend);
  m.setDiscovery(() => [tab("t-1", "Home"), tab("t-2", "AIBroker")]);
  // Nothing has registered anything. Before the fix this said "No sessions."
  const out = m.formatSessionList();
  assert.match(out, /Home/);
  assert.match(out, /AIBroker/);
  assert.equal(m.listSessions().length, 2);
});

test("looking and finding nothing is reported as nothing", () => {
  const m = new HybridSessionManager(backend);
  m.setDiscovery(() => []);
  assert.equal(m.formatSessionList(), "No sessions.");
});

test("being unable to look is NOT reported as nothing", () => {
  // The distinction the whole evening turned on: "none" and "could not tell"
  // must not share a sentence.
  const m = new HybridSessionManager(backend);
  m.setDiscovery(() => { throw new Error("AppleScript timed out"); });
  const out = m.formatSessionList();
  assert.notEqual(out, "No sessions.");
  assert.match(out, /[Cc]ould not enumerate/);
});

test("a stale list is labelled stale rather than passed off as current", () => {
  const m = new HybridSessionManager(backend);
  let fail = false;
  m.setDiscovery(() => {
    if (fail) throw new Error("iTerm went away");
    return [tab("t-1", "Home")];
  });
  assert.match(m.formatSessionList(), /Home/);
  fail = true;
  const out = m.formatSessionList();
  assert.match(out, /Home/, "the last known list is still shown — it is the best we have");
  assert.match(out, /showing last known/, "but the reader is told it is last known");
});

test("a tab that has gone is dropped once we have actually looked", () => {
  // The other half: an honest empty must prune, or a dead row survives looking
  // like a live one.
  const m = new HybridSessionManager(backend);
  let live = [tab("t-1", "Home"), tab("t-2", "AIBroker")];
  m.setDiscovery(() => live);
  assert.equal(m.listSessions().length, 2);
  live = [tab("t-1", "Home")];
  assert.equal(m.listSessions().length, 1, "the closed tab is gone");
  live = [];
  assert.equal(m.listSessions().length, 0, "an empty machine reports empty");
  assert.equal(m.formatSessionList(), "No sessions.");
});

test("the hot-path read does not go out and look", () => {
  // Delivery paths call this per message. An enumeration there would put a
  // terminal round trip in the middle of sending every notification.
  const m = new HybridSessionManager(backend);
  let calls = 0;
  m.setDiscovery(() => { calls++; return [tab("t-1", "Home")]; });
  m.knownSessions();
  m.knownSessions();
  assert.equal(calls, 0, "knownSessions() must not trigger discovery");
  m.listSessions();
  assert.equal(calls, 1, "listSessions() still does");
});

test("discovery does not steal the selection", () => {
  // registerVisualSession moves the active session to whatever it just added.
  // Discovery adds things constantly; it is not a choice by the user.
  const m = new HybridSessionManager(backend);
  let live = [tab("t-1", "Home")];
  m.setDiscovery(() => live);
  m.listSessions();
  const first = m.activeSession;
  live = [tab("t-1", "Home"), tab("t-2", "Later")];
  m.listSessions();
  assert.equal(m.activeSession?.backendSessionId, first?.backendSessionId,
    "the session the user was on stays the one they are on");
});
