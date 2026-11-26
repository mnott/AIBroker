import "./home-guard.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  splitIntoSentences, splitFirstChunk, concatWithPauses, joinTrimmed, SENTENCE_GAP_SECONDS, synthesizeChunked,
  synthesizeSentences, MAX_CHUNK_CHARS, FIRST_CHUNK_MAX_CHARS,
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

describe("splitFirstChunk — streaming first audio scales with first chunk length", () => {
  it("leaves a short first sentence untouched", () => {
    const s = ["Short opener.", "Second sentence here."];
    assert.deepEqual(splitFirstChunk(s), s);
  });
  it("cuts a long opener at the first clause break after ~25 chars, keeps the rest whole", () => {
    const first = "The quick brown fox jumps over the lazy dog, and then runs to the far end of the field.";
    const out = splitFirstChunk([first, "Next sentence."]);
    assert.equal(out.length, 3);
    assert.ok(out[0].length <= FIRST_CHUNK_MAX_CHARS, `head ${out[0].length} > ${FIRST_CHUNK_MAX_CHARS}`);
    assert.ok(out[0].includes(","), "head ends on a clause break");
    assert.equal(`${out[0]} ${out[1]}`, first);
    assert.equal(out[2], "Next sentence.");
  });
  it("cuts at a word boundary near 60 when there is no clause break", () => {
    const first = Array.from({ length: 30 }, (_, i) => `word${i}`).join(" ") + "."; // ~180 chars, no commas
    const out = splitFirstChunk([first, "Tail."]);
    assert.equal(out.length, 3);
    assert.ok(out[0].length <= FIRST_CHUNK_MAX_CHARS);
    assert.ok(/\s/.test(out[0])); // cut on a word boundary, not mid-word
    assert.equal(`${out[0]} ${out[1]}`, first);
    assert.equal(out[2], "Tail.");
  });
  it("synthesizeSentences feeds the short head first", async () => {
    const calls: string[] = [];
    const fake = { generate: async (t: string) => { calls.push(t); return { audio: new Float32Array(10), sampling_rate: 24000 }; } };
    const text = "The quick brown fox jumps over the lazy dog, and then runs to the far end of the field. Done.";
    const chunks: string[] = [];
    for await (const c of synthesizeSentences(text, "bm_fable", 1, undefined, fake)) void c;
    assert.equal(calls.length, 3);
    assert.ok(calls[0].length <= FIRST_CHUNK_MAX_CHARS, `first chunk ${calls[0].length} chars`);
    assert.ok(calls[2] === "Done.");
    void chunks;
  });
});

describe("concatenation", () => {
  it("joinTrimmed strips chunk padding: only the configured gap remains, edges kept", () => {
    const rate = 24000;
    const mk = () => {
      const pad = Math.round(rate * 0.4), tone = Math.round(rate * 0.5);
      const a = new Float32Array(pad + tone + pad);
      for (let i = 0; i < tone; i++) a[pad + i] = 0.5 * Math.sin(i / 5);
      return a;
    };
    const out = joinTrimmed([mk(), mk()], rate, 0.13);
    const loud: number[] = [];
    out.forEach((v, i) => { if (Math.abs(v) >= 0.01) loud.push(i); });
    const first = loud[0] / rate;
    const lastGap = (out.length - 1 - loud[loud.length - 1]) / rate;
    assert.ok(first >= 0.02 && first <= 0.03, `lead ${first}`);
    assert.ok(lastGap >= 0.02 && lastGap <= 0.05, `tail ${lastGap}`);
    let maxGap = 0, run = 0;
    for (const v of out) { if (Math.abs(v) < 0.01) { run++; maxGap = Math.max(maxGap, run); } else run = 0; }
    const interior = maxGap / rate;
    assert.ok(interior > 0.13 && interior < 0.2, `gap ${interior}`); // 130 ms + 2 x 20 ms edges, minus zero-crossings
    assert.ok(out.length < 2 * mk().length * 0.7);
  });
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
    assert.equal(r.audio.length, 40 * 2400 + 39 * Math.round(24000 * SENTENCE_GAP_SECONDS));
  });
});
