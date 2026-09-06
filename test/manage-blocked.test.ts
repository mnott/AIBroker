/**
 * test/manage-blocked.test.ts — telling a stuck permission prompt from a
 * busy session.
 *
 * The failure this guards against: a managed session hit a permission or
 * security prompt overnight (bypass mode escalates some of these) and sat
 * blocked for roughly four hours while the manager kept retrying arm() and
 * nobody was told. Any detector for this has one job above all others — it
 * must never fire on ordinary busy work, because a manager that stops
 * arming (or spams an alert) every time an agent runs a long tool call is
 * worse than the fault it was meant to catch. So every assertion here is
 * anchored to a REAL fixture: the actual busy panes seen overnight, pasted
 * verbatim, must come back false.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pendingPrompt, blockedReason } from "../src/daemon/manage.js";

// ── pendingPrompt: the fast, text-based path ────────────────────────────────

test("pendingPrompt fires on a constructed Claude Code permission prompt", () => {
  const pane = [
    "Bash command",
    "",
    "  rm -rf /some/path",
    "",
    "Do you want to proceed?",
    "❯ 1. Yes",
    "  2. Yes, and don't ask again for rm commands in this session",
    "  3. No, and tell Claude what to do differently (esc)",
  ].join("\n");

  assert.equal(pendingPrompt(pane), true, "should match the literal prompt text");
  assert.match(pane, /Do you want to proceed\?/, "fixture actually contains the phrase being matched");
  assert.match(pane, /❯\s*\d+\.\s*(Yes|No)\b/, "fixture actually contains a numbered choice line");
});

test("pendingPrompt is FALSE for the real overnight busy pane: a background agent status line", () => {
  // Pasted verbatim from the actual pane seen during the incident this fix
  // addresses — a session running background work, not blocked on anything.
  const pane = [
    "✻ Waiting for 1 background agent to finish",
    "  ctrl+b to run in background",
    "",
    "  ◯ engineer  Testing NSImage rasterisation via nscheck.swift    3m 19s · ↓ 116.5k tokens",
  ].join("\n");

  assert.equal(pendingPrompt(pane), false);
  assert.equal(/Do you want to proceed\?/i.test(pane), false, "no permission phrase in this fixture");
  assert.equal(/❯\s*\d+\.\s*(Yes|No)\b/.test(pane), false, "no numbered yes/no choice in this fixture");
});

test("pendingPrompt is FALSE for a plain shell prompt with the PAI banner", () => {
  const pane = [
    "  ██████╗  █████╗ ██╗",
    "  ██╔══██╗██╔══██╗██║",
    "  ██████╔╝███████║██║",
    "",
    "❯ ",
  ].join("\n");

  assert.equal(pendingPrompt(pane), false);
});

test("pendingPrompt does not fire on the word 'Yes' or 'proceed' in isolation", () => {
  assert.equal(pendingPrompt("Yes, that sounds right, let's proceed with the plan."), false);
});

// ── blockedReason: the decision that gates arming ───────────────────────────
//
// blockedReason no longer reads `armFails` — that counter resets to 0 the
// instant it hits ARM_ATTEMPTS (see manage.ts), so a content-agnostic trigger
// keyed off it never actually fires. It now reads `armFailStreak`/`stuckSince`,
// which survive that reset, combined with a static-pane confirmation.

test("blockedReason: stuckSince set + quiet 4m + no prompt text -> blocked, content-agnostic reason", () => {
  const now = 4 * 60_000;
  const m = { stuckSince: now - 4 * 60_000, lastChangeAt: now - 4 * 60_000 };
  const busyPane = "✻ Waiting for 1 background agent to finish\n◯ engineer  working    3m 19s";

  const reason = blockedReason(m, busyPane, now);
  assert.notEqual(reason, null);
  assert.match(reason as string, /^stuck /, "should describe the stuck duration, prefixed with 'stuck '");
});

test("blockedReason: stuckSince set but pane moved 10s ago -> not confirmed (recovery/busy, not blocked)", () => {
  const now = 4 * 60_000;
  const m = { stuckSince: now - 4 * 60_000, lastChangeAt: now - 10_000 };
  const busyPane = "❯ ";

  assert.equal(blockedReason(m, busyPane, now), null);
});

test("blockedReason: armFails=0 but the pane shows a prompt -> blocked immediately, on the prompt text", () => {
  const m = { armFailStreak: 0, stuckSince: undefined, lastChangeAt: 0 };
  const now = 0; // no quiet time needed — the fast path does not care about the streak or quietFor
  const promptPane = "Do you want to proceed?\n❯ 1. Yes\n  2. No, and tell Claude what to do differently";

  const reason = blockedReason(m, promptPane, now);
  assert.notEqual(reason, null);
  assert.equal(reason, "permission prompt");
});

test("blockedReason: prompt text present AND stuckSince set -> pendingPrompt wins, same reason", () => {
  const now = 4 * 60_000;
  const m = { stuckSince: now - 4 * 60_000, lastChangeAt: now - 4 * 60_000 };
  const promptPane = "Do you want to proceed?\n❯ 1. Yes\n  2. No, and tell Claude what to do differently";

  assert.equal(blockedReason(m, promptPane, now), "permission prompt");
});

test("blockedReason: armFailStreak=0, no stuckSince, long quiet, no prompt -> null (pure freeze handled elsewhere)", () => {
  const now = 20 * 60_000;
  const m = { armFailStreak: 0, stuckSince: undefined, lastChangeAt: now - 20 * 60_000 };
  const busyPane = "❯ ";

  assert.equal(blockedReason(m, busyPane, now), null);
});
