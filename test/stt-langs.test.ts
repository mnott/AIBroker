import { test } from "node:test";
import assert from "node:assert/strict";
import { allowedLangs, transcribeRestricted, type SttDeps } from "../src/core/stt.js";

function fake(detect: { lang: string; prob: number }, lp: Record<string, number>) {
  const decoded: string[] = [];
  const d: Pick<SttDeps, "serverDetect" | "serverDecode"> = {
    serverDetect: async () => detect,
    serverDecode: async (_u, _w, lang) => { decoded.push(lang); return { text: `text-${lang}`, avgLogprob: lp[lang] ?? -9 }; },
  };
  return { d, decoded };
}

test("default set is de,en,fr,pl; env overrides", () => {
  assert.deepEqual(allowedLangs({}), ["de", "en", "fr", "pl"]);
  assert.deepEqual(allowedLangs({ AIBROKER_STT_LANGS: " ES, it " }), ["es", "it"]);
});

test("detected language inside the set is used, one decode", async () => {
  const f = fake({ lang: "en", prob: 0.9 }, {});
  const r = await transcribeRestricted("u", "w", allowedLangs({}), f.d);
  assert.equal(r.lang, "en");
  assert.deepEqual(f.decoded, ["en"]);
});

test("detected pt (outside set) -> best avg_logprob of allowed four", async () => {
  const f = fake({ lang: "pt", prob: 0.8 }, { de: -0.1, en: -0.6, fr: -0.9, pl: -1.2 });
  const r = await transcribeRestricted("u", "w", allowedLangs({}), f.d);
  assert.equal(r.lang, "de");
  assert.equal(r.text, "text-de");
  assert.equal(r.detected, "pt");
  assert.deepEqual(f.decoded.sort(), ["de", "en", "fr", "pl"]);
});

test("env override restricts to de,en: pt -> never fr/pl", async () => {
  const f = fake({ lang: "pt", prob: 0.8 }, { de: -0.5, en: -0.2, fr: -0.01 });
  const r = await transcribeRestricted("u", "w", allowedLangs({ AIBROKER_STT_LANGS: "de,en" }), f.d);
  assert.equal(r.lang, "en");
  assert.deepEqual(f.decoded.sort(), ["de", "en"]);
});
