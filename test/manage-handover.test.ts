/**
 * test/manage-handover.test.ts — the handover-due decision, pinned against
 * what the investigation actually found.
 *
 * THE INVESTIGATION, in short (full q6 writeup is in the session report, not
 * here — this file pins the code, not the narrative): a fixed threshold —
 * first a constant 0.82, later suspected to need lowering to 0.60 — was
 * wrong on BOTH counts, because the thing it was a fraction OF moved. The
 * same configured override (CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=80) produced
 * compactions averaging ~1,000k before 2026-09-12 and ~784k after (see
 * measuredCompactK's own header for the real numbers). A fraction of a
 * window cannot track that; a MARGIN below a measured or assumed trigger
 * can. So the mechanism is now three bands (warm-up / refresh / immediate)
 * below an `effectiveCompactK`, not a single percentage.
 *
 * UNITS: every K-suffixed quantity below is a plain number already in
 * thousands of tokens — matching this file's own existing convention
 * (transcriptReading's contextK field, and the real history entries like
 * "at 980k tokens" pulled from a live managers.json backup during the
 * investigation, where the stored number was literally 980). `700` means
 * 700k tokens, not 700,000.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { handoverDue, effectiveCompactK, measuredCompactK, bandOf } from "../src/daemon/manage.js";

const NOW = 1_000_000_000_000;

// ── effectiveCompactK ────────────────────────────────────────────────────

test("effectiveCompactK: an override percentage scales the window", () => {
  assert.equal(effectiveCompactK({ windowK: 1000, overridePct: 80 }), 800);
});

test("effectiveCompactK: no override present falls back to the assumed 80%, not the full window", () => {
  // This is the fix for the "0.82 never fires" / "0.82 always fires" flip:
  // the configured override read 80 in BOTH observed regimes, so an ABSENT
  // override earns no more confidence than a present one did — the full
  // window (100%) was tried as the fallback and the data argued it back
  // down to the same cheap-failure assumption used when an override exists.
  assert.equal(effectiveCompactK({ windowK: 1000, overridePct: undefined }), 800);
});

test("effectiveCompactK: a measured trigger below the configured one wins", () => {
  assert.equal(effectiveCompactK({ windowK: 1000, overridePct: 80, measuredK: 784 }), 784);
});

test("effectiveCompactK: a stale-high measurement is clamped to the configured trigger", () => {
  // A project whose newest compaction predates a regime change measures the
  // old, higher boundary; trusting it would put every band above the real
  // trigger and nothing would ever fire.
  assert.equal(effectiveCompactK({ windowK: 1000, overridePct: 80, measuredK: 998 }), 800);
  assert.equal(effectiveCompactK({ windowK: 1000, overridePct: undefined, measuredK: 998 }), 800);
});

// ── measuredCompactK ─────────────────────────────────────────────────────

/** One synthetic compact_boundary line, matching the shape confirmed against
 *  a real transcript during the investigation (see handoverDue's header
 *  comment in manage.ts for the verbatim shape and source). */
function compactLine(at: string, preTokens: number): string {
  return JSON.stringify({
    type: "system",
    subtype: "compact_boundary",
    timestamp: at,
    compactMetadata: { trigger: "auto", preTokens, postTokens: 31000 },
  });
}

test("measuredCompactK: three events, k is the MINIMUM of them (the cheap-failure estimate)", () => {
  const lines = [
    compactLine("2026-09-13T08:34:18.927Z", 784066),
    compactLine("2026-09-13T16:56:30.406Z", 786126),
    compactLine("2026-09-13T11:43:56.187Z", 784208),
  ];
  const result = measuredCompactK(lines);
  assert.ok(result);
  assert.equal(result.k, 784); // min(784066, 786126, 784208) = 784066 -> 784k
  assert.equal(result.events.length, 3);
});

test("measuredCompactK: takes only the most recent three when more are present", () => {
  const lines = [
    compactLine("2026-08-01T00:00:00.000Z", 100_000), // old regime, way lower — must be excluded
    compactLine("2026-09-13T08:34:18.927Z", 784066),
    compactLine("2026-09-13T16:56:30.406Z", 786126),
    compactLine("2026-09-13T11:43:56.187Z", 784208),
  ];
  const result = measuredCompactK(lines);
  assert.ok(result);
  assert.equal(result.k, 784);
  assert.equal(result.events.length, 3);
  assert.ok(!result.events.some((e) => e.preTokens === 100_000), "the stale event must not be among the recent three");
});

test("measuredCompactK: no compact_boundary lines at all — undefined, not a false zero", () => {
  const lines = [
    JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 100 } } }),
    "not even json",
    "",
  ];
  assert.equal(measuredCompactK(lines), undefined);
});

// ── bandOf ───────────────────────────────────────────────────────────────

test("bandOf: below every band", () => {
  assert.equal(bandOf(500, 800, 100), "below");
});

test("bandOf: warm-up, refresh and immediate bands in order", () => {
  assert.equal(bandOf(700, 800, 100), "warm-up"); // 800-100
  assert.equal(bandOf(760, 800, 100), "refresh"); // 800-40
  assert.equal(bandOf(785, 800, 100), "immediate"); // 800-15
});

// ── handoverDue ──────────────────────────────────────────────────────────
//
// IDLE: idleMs is REQUIRED on every call (un-gating the ask from
// `handoverFile` widened its blast radius to every managed session, so every
// band is now also gated on the session actually being idle — see the
// dedicated idle-gating block below). Tests that are not ABOUT idleness pass
// a large `IDLE` constant so they exercise the band logic, not the gate.

const IDLE = 999_999; // comfortably above both idle floors (60s / 20s)

test("undefined context ('unknown') is never due, and says why — never coerced through 0", () => {
  const result = handoverDue({ contextK: undefined, effectiveK: 800, idleMs: IDLE, now: NOW });
  assert.equal(result.due, false);
  assert.equal(result.reason, "context unknown");
});

test("700k with a measured/override effective trigger of 800k, and dueByTime — due, warm-up", () => {
  // effective=800 (e.g. windowK=1000, overridePct=80), default margin 100 -> warmUpK=700.
  const result = handoverDue({
    contextK: 700,
    effectiveK: 800,
    idleMs: IDLE,
    // lastAskAt omitted -> sinceLast is huge -> dueByTime trivially satisfied.
    now: NOW,
  });
  assert.equal(result.due, true);
  assert.equal(result.reason, "warm-up");
});

test("the same 800k trigger, but 650k context — not due, below the warm-up band", () => {
  const result = handoverDue({ contextK: 650, effectiveK: 800, idleMs: IDLE, now: NOW });
  assert.equal(result.due, false);
  assert.match(result.reason, /below the warm-up band/);
});

test("786k against an 800k trigger — IMMEDIATE, even with no time or work signal at all", () => {
  const result = handoverDue({
    contextK: 786,
    effectiveK: 800,
    idleMs: IDLE,
    lastAskAt: NOW - 1_000, // asked one second ago
    handoverDoneK: 785, // grown by only 1k — nowhere near a work threshold
    now: NOW,
  });
  assert.equal(result.due, true);
  assert.equal(result.reason, "immediate");
});

test("no override, no measurement: full window assumed at 80% -> effective 800; 700k not due without a time/work signal", () => {
  const effectiveK = effectiveCompactK({ windowK: 1000, overridePct: undefined }); // 800
  const result = handoverDue({
    contextK: 700, // exactly at warmUpK (800-100) but no due-by-time/work signal
    effectiveK,
    idleMs: IDLE,
    lastAskAt: NOW - 1_000,
    handoverDoneK: 699,
    now: NOW,
  });
  assert.equal(result.due, false);
});

test("no override, no measurement: 720k with dueByTime -> warm-up", () => {
  const effectiveK = effectiveCompactK({ windowK: 1000, overridePct: undefined }); // 800
  const result = handoverDue({ contextK: 720, effectiveK, idleMs: IDLE, now: NOW }); // lastAskAt absent -> dueByTime true
  assert.equal(result.due, true);
  assert.equal(result.reason, "warm-up");
});

test("no override, no measurement: 790k -> immediate (800-15=785)", () => {
  const effectiveK = effectiveCompactK({ windowK: 1000, overridePct: undefined }); // 800
  const result = handoverDue({
    contextK: 790,
    effectiveK,
    idleMs: IDLE,
    lastAskAt: NOW - 1_000,
    handoverDoneK: 789,
    now: NOW,
  });
  assert.equal(result.due, true);
  assert.equal(result.reason, "immediate");
});

test("refresh band: below immediate, at/above refresh, grown enough since the last handover", () => {
  const result = handoverDue({
    contextK: 765, // >= 800-40 refreshK, < 800-15 immediateK
    effectiveK: 800,
    idleMs: IDLE,
    lastAskAt: NOW - 1_000, // recent — would fail the warm-up gate
    handoverDoneK: 700, // grown by 65k, >= REFRESH_GROWN_K (40)
    now: NOW,
  });
  assert.equal(result.due, true);
  assert.equal(result.reason, "refresh");
});

test("refresh band: same context, but not grown enough — falls through to warm-up gating", () => {
  const result = handoverDue({
    contextK: 765,
    effectiveK: 800,
    idleMs: IDLE,
    lastAskAt: NOW - 1_000, // recent, fails warm-up's time gate too
    handoverDoneK: 760, // grown by only 5k — below REFRESH_GROWN_K
    now: NOW,
  });
  assert.equal(result.due, false);
});

test("a per-session margin override changes only the warm-up band", () => {
  // marginK=200 pushes warmUpK down to 800-200=600.
  const result = handoverDue({ contextK: 650, effectiveK: 800, marginK: 200, idleMs: IDLE, now: NOW });
  assert.equal(result.due, true);
  assert.equal(result.reason, "warm-up");
});

// ── idle gating ──────────────────────────────────────────────────────────
//
// Un-gating the ask from `handoverFile` (the investigation's root-cause fix)
// means the ask now reaches every managed session, not just the one that
// happened to be opted in — so every band is ALSO gated on idleness, not
// just on the context reading. A band satisfied but the session busy reports
// due:false with a reason that names the band and the idle age, so a log
// reads as "was about to ask, held off" rather than "never qualified".

test("warm-up band satisfied, but session busy (idle 12s, floor 60s) — not due", () => {
  const result = handoverDue({ contextK: 700, effectiveK: 800, idleMs: 12_000, now: NOW });
  assert.equal(result.due, false);
  assert.match(result.reason, /band warm-up but busy \(idle 12s\)/);
});

test("refresh band satisfied, but session busy — not due", () => {
  const result = handoverDue({
    contextK: 765,
    effectiveK: 800,
    idleMs: 5_000,
    handoverDoneK: 700,
    now: NOW,
  });
  assert.equal(result.due, false);
  assert.match(result.reason, /band refresh but busy \(idle 5s\)/);
});

test("immediate band has a SHORTER idle floor (20s) than warm-up/refresh (60s)", () => {
  // 25s clears the 20s immediate floor even though it would fail the 60s floor.
  const result = handoverDue({ contextK: 790, effectiveK: 800, idleMs: 25_000, now: NOW });
  assert.equal(result.due, true);
  assert.equal(result.reason, "immediate");
});

test("immediate band's floor is never zero — 0ms idle still holds off", () => {
  const result = handoverDue({ contextK: 790, effectiveK: 800, idleMs: 0, now: NOW });
  assert.equal(result.due, false);
  assert.match(result.reason, /band immediate but busy \(idle 0s\)/);
});
