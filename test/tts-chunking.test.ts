import "./home-guard.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  splitIntoSentences, concatWithPauses, synthesizeChunked, MAX_CHUNK_CHARS,
} from "../src/adapters/kokoro/tts.js";

describe("splitIntoSentences", () => {
  it("splits on sentence ends, keeps abbreviations and decimals", () => {
    const s = splitIntoSentences("Dr. Smith paid 3.5 dollars, e.g. today. Really? Yes!");
    assert.deepEqual(s, ["Dr. Smith paid 3.5 dollars, e.g. today.", "Really?", "Yes!"]);
  });
  it("splits an over-long sentence at commas and word boundaries", () => {
    const long = Array.from({ length: 120 }, (_, i) => `word${i}`).join(" ") + ".";
    const withCommas = Array.from({ length: 60 }, (_, i) => `part ${i} of the clause`).join(", ") + ".";
    for (const t of [long, withCommas]) {
      const s = splitIntoSentences(t);
      assert.ok(s.length > 1);
      for (const c of s) assert.ok(c.length <= MAX_CHUNK_CHARS);
      assert.equal(s.join(" ").replace(/\s+/g, " "), t.replace(/\s+/g, " "));
    }
  });
});

describe("concatenation", () => {
  it("length is sum of chunks plus pauses", () => {
    const out = concatWithPauses([new Float32Array(100), new Float32Array(50), new Float32Array(10)], 1000);
    assert.equal(out.length, 160 + 2 * 250);
  });
  it("synthesizeChunked passes speed and covers every sentence", async () => {
    const calls: Array<[string, { voice: string; speed: number }]> = [];
    const fake = { generate: async (t: string, o: { voice: string; speed: number }) => {
      calls.push([t, o]); return { audio: new Float32Array(2400), sampling_rate: 24000 };
    } };
    const text = Array.from({ length: 40 }, (_, i) => `This is sentence number ${i} of the long script.`).join(" ");
    const r = await synthesizeChunked(text, "bm_fable", 0.9, fake);
    assert.equal(calls.length, 40);
    assert.ok(calls.every(([, o]) => o.speed === 0.9 && o.voice === "bm_fable"));
    assert.equal(r.audio.length, 40 * 2400 + 39 * 6000);
  });
});
