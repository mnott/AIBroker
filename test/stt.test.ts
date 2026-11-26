import "./home-guard.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  transcribeFile, resolveCppModel, wavConvertArgs, cliArgs, SttAudioError, VOICEINK_MODEL_REL,
  type SttDeps,
} from "../src/core/stt.js";

const PROBE_OK = JSON.stringify({ streams: [{ codec_name: "aac" }], format: { duration: "4.2" } });

function fake(over: Partial<SttDeps> & { calls?: string[]; files?: Set<string>; probe?: string; failBins?: string[] } = {}): SttDeps {
  const calls = over.calls ?? [];
  const files = over.files ?? new Set<string>();
  const failBins = over.failBins ?? [];
  const home = "/h";
  files.add("/in.m4a");
  files.add(`${home}/${VOICEINK_MODEL_REL}`);
  return {
    exists: (p) => files.has(p) || [...files].some((f) => f === p),
    run: async (bin, args) => {
      const name = bin.split("/").pop()!;
      calls.push(name);
      if (failBins.includes(name)) throw new Error(`${name} boom`);
      if (name === "ffprobe") return over.probe ?? PROBE_OK;
      if (name === "ffmpeg") { files.add(args[args.length - 1]); return ""; }
      if (name === "whisper-cli") { files.add(`${args[args.indexOf("-of") + 1]}.txt`); return ""; }
      if (name === "whisper") { files.add(`${args[args.indexOf("--output_dir") + 1]}/in.txt`); return ""; }
      return "";
    },
    readText: (p) => (p.endsWith("in.txt") ? " python text " : " cli text "),
    remove: (p) => { files.delete(p); },
    serverDetect: async () => ({ lang: "de", prob: 0.99 }),
    serverDecode: async () => ({ text: " server text [BLANK_AUDIO]", avgLogprob: -0.1 }),
    ensureServer: async () => "http://127.0.0.1:1",
    env: {},
    home,
    ...over,
  };
}

describe("stt", () => {
  it("model: env wins, then VoiceInk, then cache, else null", () => {
    const files = new Set(["/e.bin"]);
    assert.equal(resolveCppModel({ exists: (p) => files.has(p), env: { AIBROKER_WHISPER_CPP_MODEL: "/e.bin" }, home: "/h" }), "/e.bin");
    assert.equal(resolveCppModel({ exists: () => false, env: { AIBROKER_WHISPER_CPP_MODEL: "/missing" }, home: "/h" }), null);
    assert.equal(resolveCppModel({ exists: () => false, env: {}, home: "/nonexistent-h" }), null);
    const vi = `/h/${VOICEINK_MODEL_REL}`;
    assert.equal(resolveCppModel({ exists: (p) => p === vi, env: {}, home: "/h" }), vi);
  });

  it("wav args: 16k mono pcm; cli args auto language", () => {
    const a = wavConvertArgs("/in.m4a", "/o.wav");
    assert.deepEqual(a.slice(a.indexOf("-ar"), a.indexOf("-ar") + 4), ["-ar", "16000", "-ac", "1"]);
    assert.equal(a[a.length - 1], "/o.wav");
    const c = cliArgs("/m.bin", "/o.wav", "/out");
    assert.ok(c.includes("-otxt") && c.join(" ").includes("-l auto"));
  });

  it("prefers whisper-server and cleans blank tokens", async () => {
    const calls: string[] = [];
    const r = await transcribeFile("/in.m4a", fake({ calls }));
    assert.equal(r.backend, "whisper-server");
    assert.equal(r.text, "server text");
    assert.equal(r.audioSec, 4.2);
    assert.deepEqual(calls, ["ffprobe", "ffmpeg"]);
  });

  it("falls back server -> cli -> python", async () => {
    const calls: string[] = [];
    const noServer = fake({ calls, ensureServer: async () => null });
    assert.equal((await transcribeFile("/in.m4a", noServer)).backend, "whisper-cli");
    const failing = fake({ calls, serverDetect: async () => { throw new Error("x"); }, failBins: ["whisper-cli"] });
    const r = await transcribeFile("/in.m4a", failing);
    assert.equal(r.backend, "python-whisper");
    assert.equal(r.text, "python text");
  });

  it("no model -> python only, no ffmpeg", async () => {
    const calls: string[] = [];
    const files = new Set<string>();
    const d = fake({ calls, files });
    files.delete(`/h/${VOICEINK_MODEL_REL}`);
    const r = await transcribeFile("/in.m4a", d);
    assert.equal(r.backend, "python-whisper");
    assert.ok(!calls.includes("ffmpeg"));
  });

  it("invalid audio is rejected before any backend runs", async () => {
    for (const probe of [JSON.stringify({ streams: [], format: {} }), JSON.stringify({ streams: [{ codec_name: "aac" }], format: { duration: "0.1" } }), "garbage"]) {
      const calls: string[] = [];
      await assert.rejects(transcribeFile("/in.m4a", fake({ calls, probe })), SttAudioError);
      assert.deepEqual(calls, ["ffprobe"]);
    }
    await assert.rejects(transcribeFile("/nope.m4a", fake()), SttAudioError);
  });

  it("empty transcript is returned as empty text with metadata", async () => {
    const r = await transcribeFile("/in.m4a", fake({ serverDecode: async () => ({ text: "[BLANK_AUDIO]", avgLogprob: -1 }) }));
    assert.equal(r.text, "");
    assert.equal(r.backend, "whisper-server");
  });
});

// --- voice batch window ---
import { mock, test } from "node:test";
import { createVoiceBatcher, voiceBatchWindowMs } from "../src/adapters/pailot/voice-batch.js";

test("voice batch window defaults to 800ms and honours AIBROKER_VOICE_BATCH_MS", () => {
  assert.equal(voiceBatchWindowMs({}), 800);
  assert.equal(voiceBatchWindowMs({ AIBROKER_VOICE_BATCH_MS: "250" }), 250);
  assert.equal(voiceBatchWindowMs({ AIBROKER_VOICE_BATCH_MS: "x" }), 800);
});

test("voice batch: single note flushes after the window", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const out: string[][] = [];
  const b = createVoiceBatcher((t) => out.push(t), () => 800);
  b.add("hello");
  mock.timers.tick(799);
  assert.equal(out.length, 0);
  mock.timers.tick(1);
  assert.deepEqual(out, [["hello"]]);
  mock.timers.reset();
});

test("voice batch: two notes within the window are joined", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const out: string[][] = [];
  const b = createVoiceBatcher((t) => out.push(t), () => 800);
  b.add("one");
  mock.timers.tick(500);
  b.add("two");
  mock.timers.tick(799);
  assert.equal(out.length, 0);
  mock.timers.tick(1);
  assert.deepEqual(out, [["one", "two"]]);
  mock.timers.reset();
});
