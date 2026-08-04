/**
 * test/session-match.test.ts — one resolver, three former behaviours.
 *
 * There used to be three ways to decide which session a name meant, each fixed
 * on its own. `task-bus` failed to match a session called `Task Bus`
 * in dispatch while send_to_session would have found it — and in dispatch a
 * miss does not fail, it spawns a duplicate tab with none of the context.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchSession, normaliseLabel, labelOf } from "../src/core/session-match.js";

const sessions = [
  { id: "s-claude", name: "✳ Task Bus (node)", paiName: "Task Bus" },
  { id: "s-other", name: "✳ Voice Notes (node)", paiName: "Voice Notes" },
  { id: "s-shell", name: "~/dev/ai/clickr (-zsh)", paiName: null },
  { id: "s-clickr", name: "✳ Clickr (node)", paiName: "Clickr" },
];

test("separators fold, so an alias finds a human-named session", () => {
  const hit = matchSession(["task-bus"], sessions);
  assert.equal(hit?.session.id, "s-claude");
  assert.equal(hit?.kind, "normalised");
});

test("an exact match is reported as exact", () => {
  assert.equal(matchSession(["Task Bus"], sessions)?.kind, "exact");
});

test("substring is off by default", () => {
  // A project called `sl` must not match every session containing those
  // letters — here a wrong match delivers work to the wrong place.
  assert.equal(matchSession(["jobs"], sessions), null);
});

test("substring resolves when the caller asks for it", () => {
  const hit = matchSession(["clickr"], sessions, { kinds: ["exact", "normalised", "substring"] });
  assert.ok(hit);
});

test("a live session outranks a dead shell that matches better", () => {
  // Every ended session leaves a shell tab behind. Addressing "clickr" once
  // matched the leftover shell sitting in ~/dev/ai/clickr and the message was
  // EXECUTED there rather than read. Preference must dominate match quality.
  const hit = matchSession(["clickr"], sessions, {
    kinds: ["exact", "normalised", "substring"],
    prefer: (s) => (s.id.startsWith("s-clickr") ? 1 : 0),
  });
  assert.equal(hit?.session.id, "s-clickr");
});

test("no reference matches nothing rather than the first session", () => {
  assert.equal(matchSession([], sessions), null);
  assert.equal(matchSession([""], sessions), null);
});

test("distinct names do not collide once separators fold", () => {
  assert.equal(matchSession(["voice-notes"], sessions)?.session.id, "s-other");
});

test("normaliseLabel folds every separator to one space", () => {
  assert.equal(normaliseLabel("Task__Bus"), "task bus");
  assert.equal(normaliseLabel("  09 - Voice   Notes "), "09 voice notes");
});

test("labelOf prefers the persistent name over the tab title", () => {
  assert.equal(labelOf(sessions[0]), "Task Bus");
  assert.equal(labelOf(sessions[2]), "~/dev/ai/clickr (-zsh)");
});
