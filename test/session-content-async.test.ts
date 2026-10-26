import "./home-guard.js";
/**
 * test/session-content-async.test.ts — the manager's pane read must not block
 * the event loop, and a tail-only capture must still carry everything the
 * manager reads (the live input box).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { _internal } from "../src/adapters/iterm/core.js";
import { readSessionContentAsync } from "../src/daemon/session-content.js";
import { promptUnsentText } from "../src/daemon/manage.js";

const RULE = "──────────────────────────────────────────────────────────────────";
const live = ["✻ Cerebrating… (19m 0s)", RULE, "❯ unsent goal text", RULE, "  👋 PAI CC in Example"];

/** What the JXA returns: name, atPrompt, paiName, then the (already cut) tail. */
const reply = (lines: string[]) => ["tab", "false", "", lines.join("\n")].join("\t");

test("readSessionContentAsync parses the reply and keeps only the requested tail", async () => {
  const scrollback = Array.from({ length: 500 }, (_, i) => `old line ${i}`);
  const original = _internal.runItermJxaAsync;
  let script = "";
  _internal.runItermJxaAsync = async (s) => { script = s; return reply([...scrollback, ...live]); };
  try {
    const r = await readSessionContentAsync("sess-a", 60, { fresh: true });
    assert.ok(r);
    assert.equal(r.name, "tab");
    assert.equal(r.content.split("\n").length, 60);
    assert.equal(promptUnsentText(r.content), "unsent goal text");
    // the cut happens inside osascript, so only the tail crosses the pipe
    assert.match(script, /allLines\.slice\(allLines\.length - 100\)/);
  } finally {
    _internal.runItermJxaAsync = original;
  }
});

test("promptUnsentText finds the live box in a capture truncated to the last 100 lines", () => {
  const tail = [...Array.from({ length: 95 }, (_, i) => `out ${i}`), ...live].slice(-100);
  assert.equal(promptUnsentText(tail.join("\n")), "unsent goal text");
});

test("an async read leaves the event loop running while iTerm is slow", async () => {
  const original = _internal.runItermJxaAsync;
  _internal.runItermJxaAsync = () => new Promise((res) => setTimeout(() => res(reply(live)), 300));
  let ticks = 0;
  const timer = setInterval(() => ticks++, 20);
  try {
    await readSessionContentAsync("sess-b", 60, { fresh: true });
  } finally {
    clearInterval(timer);
    _internal.runItermJxaAsync = original;
  }
  assert.ok(ticks >= 8, `event loop ticked only ${ticks}x during a 300ms read`);
});

test("a NOT_FOUND reply reads as no session", async () => {
  const original = _internal.runItermJxaAsync;
  _internal.runItermJxaAsync = async () => "NOT_FOUND";
  try {
    assert.equal(await readSessionContentAsync("sess-c", 60, { fresh: true }), null);
  } finally {
    _internal.runItermJxaAsync = original;
  }
});
