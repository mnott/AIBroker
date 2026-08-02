/**
 * test/persistence.test.ts — the session registry and voice config must not
 * delete themselves either.
 *
 * `core/json-store.ts` fixed the shape for the stores that use `GuardedStore`,
 * but `core/persistence.ts` kept its own `safeReadJson`/`safeWriteJson` pair,
 * and those two still turned an unparseable file into `null`, substituted an
 * empty value, and made it permanent on the next ordinary save — losing every
 * session name on a rename, or every custom voice persona on a mode toggle.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  setAppDir,
  loadVoiceConfig,
  saveVoiceConfig,
  DEFAULT_VOICE_CONFIG,
  loadSessionRegistry,
  saveSessionRegistry,
} from "../src/core/persistence.js";
import { sessionRegistry, setVoiceConfig } from "../src/core/state.js";

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "aibroker-persist-"));
  setAppDir(dir);
  return dir;
}

/** Module state is global; each test starts from a known-empty registry. */
function reset(): void {
  sessionRegistry.clear();
  setVoiceConfig({ ...DEFAULT_VOICE_CONFIG });
}

// ── sessions.json ───────────────────────────────────────────────────────────

test("a corrupt session registry is not overwritten by the next save", () => {
  const dir = tmp();
  reset();
  const p = join(dir, "sessions.json");
  const original = '{"sessions":[{"sessionId":"a","name":"clickr"} CORRUPTED';
  writeFileSync(p, original);

  loadSessionRegistry();
  assert.equal(sessionRegistry.size, 0, "load still yields a usable empty registry");

  // The ordinary update that used to make the emptiness permanent.
  sessionRegistry.set("b", { sessionId: "b", name: "new", registeredAt: Date.now() });
  saveSessionRegistry();

  assert.equal(readFileSync(p, "utf-8"), original, "the file on disk must be untouched");
  rmSync(dir, { recursive: true, force: true });
});

test("a readable session registry round-trips and keeps a .bak", () => {
  const dir = tmp();
  reset();
  const p = join(dir, "sessions.json");
  writeFileSync(p, JSON.stringify({ activeItermSessionId: "", sessions: [{ sessionId: "a", name: "clickr" }] }));

  loadSessionRegistry();
  assert.equal(sessionRegistry.get("a")?.name, "clickr");

  sessionRegistry.set("b", { sessionId: "b", name: "aibroker", registeredAt: Date.now() });
  saveSessionRegistry();

  const written = JSON.parse(readFileSync(p, "utf-8")) as { sessions: Array<{ sessionId: string }> };
  assert.deepEqual(written.sessions.map((s) => s.sessionId).sort(), ["a", "b"]);
  assert.equal(existsSync(`${p}.bak`), true, "the previous contents must be recoverable");
  rmSync(dir, { recursive: true, force: true });
});

test("a missing session registry saves normally — absence is legitimate", () => {
  const dir = tmp();
  reset();
  loadSessionRegistry();
  sessionRegistry.set("a", { sessionId: "a", name: "clickr", registeredAt: Date.now() });
  saveSessionRegistry();
  const written = JSON.parse(readFileSync(join(dir, "sessions.json"), "utf-8")) as {
    sessions: Array<{ name: string }>;
  };
  assert.deepEqual(written.sessions.map((s) => s.name), ["clickr"]);
  rmSync(dir, { recursive: true, force: true });
});

// ── voice-config.json ───────────────────────────────────────────────────────

test("a corrupt voice config is not replaced by the defaults", () => {
  // The loss here is quiet: the merge with DEFAULT_VOICE_CONFIG produces a
  // working config, so nothing looks wrong until the custom personas are gone.
  const dir = tmp();
  reset();
  const p = join(dir, "voice-config.json");
  const original = '{"defaultVoice":"af_nicole","personas":{"Matthias":"bm_daniel"} TRUNCATED';
  writeFileSync(p, original);

  const merged = loadVoiceConfig();
  assert.equal(merged.defaultVoice, DEFAULT_VOICE_CONFIG.defaultVoice, "falls back to a usable config");

  saveVoiceConfig({ ...merged, voiceMode: true });
  assert.equal(readFileSync(p, "utf-8"), original, "the file on disk must be untouched");
  rmSync(dir, { recursive: true, force: true });
});

test("a readable voice config round-trips", () => {
  const dir = tmp();
  reset();
  const p = join(dir, "voice-config.json");
  writeFileSync(p, JSON.stringify({ defaultVoice: "af_nicole", personas: { Matthias: "bm_daniel" } }));

  const merged = loadVoiceConfig();
  assert.equal(merged.defaultVoice, "af_nicole");
  assert.equal(merged.personas.Matthias, "bm_daniel", "custom personas survive the merge");
  assert.equal(merged.personas.Fable, DEFAULT_VOICE_CONFIG.personas.Fable, "defaults still fill in");

  saveVoiceConfig({ ...merged, voiceMode: true });
  const written = JSON.parse(readFileSync(p, "utf-8")) as { voiceMode: boolean; personas: Record<string, string> };
  assert.equal(written.voiceMode, true);
  assert.equal(written.personas.Matthias, "bm_daniel");
  rmSync(dir, { recursive: true, force: true });
});

// ── the block is per-file and clears on a good read ─────────────────────────

test("one unreadable file does not block the other store", () => {
  const dir = tmp();
  reset();
  writeFileSync(join(dir, "voice-config.json"), "NOT JSON");
  loadVoiceConfig();

  loadSessionRegistry();
  sessionRegistry.set("a", { sessionId: "a", name: "clickr", registeredAt: Date.now() });
  saveSessionRegistry();

  assert.equal(existsSync(join(dir, "sessions.json")), true, "sessions.json is a different file");
  assert.equal(readFileSync(join(dir, "voice-config.json"), "utf-8"), "NOT JSON");
  rmSync(dir, { recursive: true, force: true });
});

test("fixing the file and re-reading it unblocks saving", () => {
  const dir = tmp();
  reset();
  const p = join(dir, "voice-config.json");
  writeFileSync(p, "NOT JSON");
  loadVoiceConfig();

  // Operator repairs it; the next load re-reads and clears the block.
  writeFileSync(p, JSON.stringify({ defaultVoice: "bm_george" }));
  const merged = loadVoiceConfig();
  assert.equal(merged.defaultVoice, "bm_george");

  saveVoiceConfig({ ...merged, voiceMode: true });
  const written = JSON.parse(readFileSync(p, "utf-8")) as { voiceMode: boolean };
  assert.equal(written.voiceMode, true, "saving must work again");
  rmSync(dir, { recursive: true, force: true });
});
