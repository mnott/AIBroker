import "./home-guard.js";
/**
 * test/session-voice.test.ts — per-session voice settings.
 *
 * A session asking "reply in voice, slower" must change only its own entry and
 * never anyone else's defaults; speed must clamp to 0.5..2 and round to 0.05 so
 * repeated nudges do not drift into float noise; and the store must follow the
 * guarded pattern the other stores use — an unparseable file blocks writes
 * rather than being replaced with the empty default we substituted for it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scratch = mkdtempSync(join(tmpdir(), "aibroker-session-voice-"));
process.env.HOME = scratch;

const { setAppDir } = await import("../src/core/persistence.js");
const { getSessionVoice, setSessionVoice, adjustSessionSpeed, DEFAULT_SESSION_SETTINGS } = await import("../src/daemon/session-voice.js");

setAppDir(scratch);

test("defaults: replyInVoice false, speed 1.0", () => {
  const s = getSessionVoice("session:fresh");
  assert.equal(s.replyInVoice, false);
  assert.equal(s.speed, 1.0);
  assert.equal(s.voice, undefined);
  assert.deepEqual(s, DEFAULT_SESSION_SETTINGS);
});

test("set persists replyInVoice and voice across reads", () => {
  setSessionVoice("session:alpha", { replyInVoice: true, voice: "af_bella" });
  const s = getSessionVoice("session:alpha");
  assert.equal(s.replyInVoice, true);
  assert.equal(s.voice, "af_bella");
  // another session is untouched
  assert.equal(getSessionVoice("session:beta").replyInVoice, false);
});

test("speed clamps to 0.5..2 and rounds to 0.05", () => {
  assert.equal(setSessionVoice("s:x", { speed: 9 }).speed, 2);
  assert.equal(setSessionVoice("s:x", { speed: 0.1 }).speed, 0.5);
  assert.equal(setSessionVoice("s:x", { speed: 1.376 }).speed, 1.4);
  assert.equal(setSessionVoice("s:x", { speed: 1.32 }).speed, 1.3);
});

test("adjustSpeed nudges by delta and clamps at the edges", () => {
  setSessionVoice("s:n", { speed: 1 });
  assert.equal(adjustSessionSpeed("s:n", -0.1).speed, 0.9);
  assert.equal(adjustSessionSpeed("s:n", -0.5).speed, 0.5);
  assert.equal(adjustSessionSpeed("s:n", 3).speed, 2);
  // non-finite delta is a no-op
  assert.equal(adjustSessionSpeed("s:n", Number.NaN).speed, 2);
});

test("empty voice string clears the override", () => {
  setSessionVoice("s:v", { voice: "bf_sara" });
  assert.equal(getSessionVoice("s:v").voice, "bf_sara");
  setSessionVoice("s:v", { voice: "" });
  assert.equal(getSessionVoice("s:v").voice, undefined);
});

test("persistence round trip through voice-sessions.json", () => {
  setSessionVoice("session:gamma", { replyInVoice: true, speed: 0.75, voice: "am_adam" });
  const raw = JSON.parse(readFileSync(join(scratch, "voice-sessions.json"), "utf-8"));
  assert.deepEqual(raw["session:gamma"], { replyInVoice: true, speed: 0.75, voice: "am_adam" });
});

test("a corrupt store is not overwritten by the next save", () => {
  const p = join(scratch, "voice-sessions.json");
  writeFileSync(p, '{"session:one":{"replyInVoice":true} CORRUPT');
  // first read records the block
  assert.equal(getSessionVoice("session:one").replyInVoice, false);
  setSessionVoice("session:two", { replyInVoice: true });
  assert.equal(readFileSync(p, "utf-8"), '{"session:one":{"replyInVoice":true} CORRUPT', "unreadable file must survive");
});

test("a good read clears the block and writes resume", () => {
  const p = join(scratch, "voice-sessions.json");
  writeFileSync(p, JSON.stringify({ "session:ok": { replyInVoice: true, speed: 1 } }));
  setSessionVoice("session:ok", { speed: 0.5 });
  assert.equal(getSessionVoice("session:ok").speed, 0.5);
  assert.equal(existsSync(p), true);
});
