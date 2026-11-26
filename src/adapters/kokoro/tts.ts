/**
 * adapters/kokoro/tts.ts — Kokoro TTS synthesis pipeline.
 *
 * Converts text to OGG Opus audio buffers (for sending as voice notes)
 * or plays locally via afplay. No transport SDK imports.
 *
 * Pipeline: Kokoro-js → Float32 PCM → WAV → ffmpeg → OGG Opus
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { log } from "../../core/log.js";
import { resolveFfmpegBin } from "../../core/bins.js";
import { sidecarSupervisor, streamSidecar, resolveBackend } from "./sidecar.js";


export type KokoroVoice =
  | "af_heart" | "af_alloy" | "af_aoede" | "af_bella" | "af_jessica"
  | "af_kore" | "af_nicole" | "af_nova" | "af_river" | "af_sarah" | "af_sky"
  | "am_adam" | "am_echo" | "am_eric" | "am_fenrir" | "am_liam"
  | "am_michael" | "am_onyx" | "am_puck" | "am_santa"
  | "bf_alice" | "bf_emma" | "bf_isabella" | "bf_lily"
  | "bm_daniel" | "bm_fable" | "bm_george" | "bm_lewis";

const KNOWN_VOICES: KokoroVoice[] = [
  "af_heart", "af_alloy", "af_aoede", "af_bella", "af_jessica",
  "af_kore", "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
  "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam",
  "am_michael", "am_onyx", "am_puck", "am_santa",
  "bf_alice", "bf_emma", "bf_isabella", "bf_lily",
  "bm_daniel", "bm_fable", "bm_george", "bm_lewis",
];

const DEFAULT_VOICE: KokoroVoice =
  (process.env.AIBROKER_TTS_VOICE as KokoroVoice | undefined) ??
  (process.env.MSGBRIDGE_TTS_VOICE as KokoroVoice | undefined) ??
  (process.env.WHAZAA_TTS_VOICE as KokoroVoice | undefined) ??
  "bm_fable";

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

/**
 * ONNX dtype for synthesis. Measured 2026-11-25 on CPU (one ~15-word sentence):
 * q8 real-time factor 0.65 (synthesis slower than playback, so streaming stalls
 * between sentences), fp32 1.15, fp16 1.06, q4 1.20. fp32 is already in the
 * local model cache; AIBROKER_TTS_DTYPE overrides for experiments.
 */
type KokoroDtype = "fp32" | "fp16" | "q8" | "q4" | "q4f16";
const DTYPE: KokoroDtype = (process.env.AIBROKER_TTS_DTYPE as KokoroDtype | undefined) ?? "fp32";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ttsInstance: any | null = null;
let initPromise: Promise<void> | null = null;

async function ensureInitialized(): Promise<void> {
  if (ttsInstance !== null) return;
  if (initPromise !== null) { await initPromise; return; }

  initPromise = (async () => {
    log(`Initializing Kokoro TTS (model: ${MODEL_ID}, dtype: ${DTYPE})...`);
    const { KokoroTTS } = await import("kokoro-js");
    ttsInstance = await KokoroTTS.from_pretrained(MODEL_ID, { dtype: DTYPE, device: "cpu" });
    log("Kokoro TTS ready.");
  })();

  await initPromise;
}

/**
 * Convert text to an OGG Opus voice note buffer.
 */
export async function textToVoiceNote(text: string, voice?: string, speed?: number): Promise<Buffer> {
  if (!text?.trim()) throw new Error("TTS: text must not be empty");

  const FFMPEG = resolveFfmpegBin();
  if (FFMPEG === "ffmpeg" && !existsSync("/usr/bin/ffmpeg")) {
    log("Warning: ffmpeg not found at known Homebrew paths; falling back to bare 'ffmpeg'.");
  }

  const resolvedVoice = resolveVoice(voice ?? DEFAULT_VOICE);

  log(`Generating audio: voice=${resolvedVoice}, text="${text.slice(0, 60)}${text.length > 60 ? "..." : ""}"`);

  // synthesizeChunked routes through the mlx sidecar when it is up; CPU fallback inside.
  const { audio: combined, sampleRate } = await synthesizeChunked(text, resolvedVoice, speed);

  log(`Generated ${combined.length} samples at ${sampleRate} Hz`);

  const uid = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const wavPath = join(tmpdir(), `aibroker-tts-${uid}.wav`);
  const oggPath = join(tmpdir(), `aibroker-tts-${uid}.ogg`);

  try {
    writeFileSync(wavPath, float32ToWav(combined, sampleRate));

    const ffmpegCmd = `"${FFMPEG}" -y -i "${wavPath}" -c:a libopus -b:a 64k -ar 24000 -ac 1 -application voip -vbr off "${oggPath}" 2>&1`;
    try {
      execSync(ffmpegCmd, { timeout: 30_000, stdio: "pipe" });
    } catch (err) {
      throw new Error(`ffmpeg conversion failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!existsSync(oggPath)) throw new Error("ffmpeg did not produce output file");

    const oggBuffer = readFileSync(oggPath);
    log(`Converted to OGG Opus: ${oggBuffer.length} bytes`);
    return oggBuffer;
  } finally {
    for (const p of [wavPath, oggPath]) {
      try { if (existsSync(p)) unlinkSync(p); } catch { /* ignore */ }
    }
  }
}

/**
 * Synthesize text and play locally. Thin wrapper over the machine-wide playback
 * queue: synthesis streams sentence by sentence while audio plays, jobs run one
 * after another, and a recording in progress holds playback. Imported lazily so
 * tts.js does not depend on playback.js at load time.
 */
export async function speakLocally(text: string, voice?: string, speed?: number): Promise<void> {
  if (!text?.trim()) throw new Error("TTS: text must not be empty");

  const resolvedVoice = resolveVoice(voice ?? DEFAULT_VOICE);
  log(`Speaking locally: voice=${resolvedVoice}, text="${text.slice(0, 60)}${text.length > 60 ? "..." : ""}"`);

  const { enqueueSpeech } = await import("./playback.js");
  enqueueSpeech({ session: "local", text, voice: resolvedVoice, speed });
}

export function listVoices(): string[] {
  return [...KNOWN_VOICES];
}

// ── Chunked synthesis ──

/** kokoro-js truncates input beyond its token window; stay well below it. */
export const MAX_CHUNK_CHARS = 300;
export const PAUSE_SECONDS = 0.25;

/** Streaming first-chunk limits: cut a long opener at a clause break after ≥25
 * chars, else at a word boundary near 60 (see splitFirstChunk). */
export const FIRST_CHUNK_MIN_CHARS = 25;
export const FIRST_CHUNK_MAX_CHARS = 60;

const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc", "e.g", "i.e",
  "inc", "ltd", "no", "approx", "fig", "u.s", "a.m", "p.m",
]);

function endsWithAbbreviation(s: string): boolean {
  const m = /([A-Za-z][A-Za-z.]*)\.$/.exec(s);
  if (!m) return false;
  const w = m[1].toLowerCase();
  return ABBREVIATIONS.has(w) || /^[a-z]$/.test(w);
}

/** Split an over-long piece at commas/semicolons/colons, then at word boundaries. */
function splitLong(piece: string, max: number): string[] {
  if (piece.length <= max) return [piece];
  const out: string[] = [];
  let cur = "";
  const push = (t: string) => { if (t.trim()) out.push(t.trim()); };
  const parts = piece.split(/(?<=[,;:\u2014])\s+/);
  for (const part of parts) {
    if (part.length > max) {
      push(cur); cur = "";
      let w = "";
      for (const word of part.split(/\s+/)) {
        if (word.length > max) {
          push(w); w = "";
          for (let i = 0; i < word.length; i += max) push(word.slice(i, i + max));
        } else if (w && w.length + 1 + word.length > max) { push(w); w = word; }
        else w = w ? `${w} ${word}` : word;
      }
      cur = w;
    } else if (cur && cur.length + 1 + part.length > max) { push(cur); cur = part; }
    else cur = cur ? `${cur} ${part}` : part;
  }
  push(cur);
  return out;
}

/**
 * Split text into sentence-sized chunks, each at most maxChars. Abbreviations
 * ("Dr.", "e.g.") and decimals ("3.5") do not end a sentence.
 */
export function splitIntoSentences(text: string, maxChars = MAX_CHUNK_CHARS): string[] {
  const flat = text.replace(/\s*\n+\s*/g, " ").trim();
  if (!flat) return [];
  const sentences: string[] = [];
  let cur = "";
  for (const tok of flat.split(/\s+/)) {
    cur = cur ? `${cur} ${tok}` : tok;
    if (/[.!?]["')\]]*$/.test(tok) && !(tok.endsWith(".") && endsWithAbbreviation(tok))) {
      sentences.push(cur);
      cur = "";
    }
  }
  if (cur) sentences.push(cur);
  return sentences.flatMap((s) => splitLong(s, maxChars));
}

/**
 * Split the first chunk short for streaming playback: time to first audio scales
 * with the length of the first chunk, so a long opening sentence is cut at the
 * first comma/semicolon/dash after ~25 characters, or at a word boundary near 60.
 * Returns the leading piece plus the remainder; sentences ≤ 60 chars are untouched.
 */
export function splitFirstChunk(sentences: string[]): string[] {
  if (sentences.length === 0) return [];
  const first = sentences[0];
  if (first.length <= FIRST_CHUNK_MAX_CHARS) return sentences;

  // Prefer a clause break past the minimum prefix; keep it within the target size.
  let cut = -1;
  for (const m of first.matchAll(/[,;—]\s+/g)) {
    if (m.index >= FIRST_CHUNK_MIN_CHARS && m.index <= FIRST_CHUNK_MAX_CHARS) {
      cut = m.index + 1; // keep the punctuation with the head
      break;
    }
  }
  if (cut < 0) {
    // No clause break: cut at the last word boundary that keeps the prefix ≤ 60.
    let lastBoundary = -1;
    for (const m of first.matchAll(/\s+/g)) {
      if (m.index <= FIRST_CHUNK_MAX_CHARS) lastBoundary = m.index;
      else break;
    }
    cut = lastBoundary > 0 ? lastBoundary : Math.min(FIRST_CHUNK_MAX_CHARS, first.length);
  }

  const head = first.slice(0, cut).trim();
  const tail = first.slice(cut).trim();
  if (!head || !tail) return sentences;
  return [head, tail, ...sentences.slice(1)];
}

/** Concatenate PCM chunks with a silence gap between them. */
export function concatWithPauses(chunks: Float32Array[], sampleRate: number, pauseSeconds = PAUSE_SECONDS): Float32Array {
  const gap = Math.round(sampleRate * pauseSeconds);
  const total = chunks.reduce((n, c) => n + c.length, 0) + gap * Math.max(0, chunks.length - 1);
  const out = new Float32Array(total);
  let off = 0;
  chunks.forEach((c, i) => {
    if (i > 0) off += gap;
    out.set(c, off);
    off += c.length;
  });
  return out;
}

/** Generate each sentence separately and join into one PCM buffer. */
export async function synthesizeChunked(
  text: string,
  voice: string,
  speed?: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tts?: any,
): Promise<{ audio: Float32Array; sampleRate: number }> {
  const pcm: Float32Array[] = [];
  let sampleRate = 24_000;
  for await (const chunk of synthesizeSentences(text, voice, speed, undefined, tts)) {
    sampleRate = chunk.sampleRate;
    if (chunk.audio.length > 0) pcm.push(chunk.audio);
  }
  if (pcm.length === 0) throw new Error("TTS: generate produced no audio");
  return { audio: concatWithPauses(pcm, sampleRate), sampleRate };
}

/**
 * Synthesize sentence by sentence, yielding each chunk as soon as it is ready.
 * Streaming playback consumes this; the first chunk arrives after only one
 * sentence's synthesis instead of the whole text's. Aborts between sentences
 * when `signal` fires so stopPlayback() can end a job mid-synthesis.
 *
 * Backend: the Metal sidecar (~100 ms to first audio) when it is up; otherwise
 * kokoro-js on CPU (~4.5 s cold). A sidecar failure mid-stream falls back to
 * CPU for the remaining sentences rather than dropping audio. Which path served
 * is logged once per request.
 */
export async function* synthesizeSentences(
  text: string,
  voice: string,
  speed?: number,
  signal?: AbortSignal,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tts?: any,
): AsyncGenerator<{ audio: Float32Array; sampleRate: number; endsSentence?: boolean }> {
  voice = resolveVoice(voice || DEFAULT_VOICE);
  const sentences = splitFirstChunk(splitIntoSentences(text));
  const rate = speed !== undefined && Number.isFinite(speed) && speed > 0 ? speed : 1.0;
  let sampleRate = 24_000;

  // Explicitly-provided tts instance (tests, experiments) bypasses the router.
  if (tts) {
    for (const s of sentences) {
      if (signal?.aborted) throw new Error("TTS: synthesis aborted");
      const r = await tts.generate(s, { voice, speed: rate });
      sampleRate = r.sampling_rate ?? sampleRate;
      if (r.audio && r.audio.length > 0) yield { audio: r.audio, sampleRate, endsSentence: true };
    }
    return;
  }

  // Try the Metal sidecar first; on any failure fall back to CPU for what is left.
  const port = await sidecarSupervisor.currentPort();
  if (port !== null && resolveBackend() === "mlx") {
    try {
      let served = 0;
      for await (const chunk of streamSidecar(port, { text: sentences.join(" "), voice, speed: rate }, signal)) {
        sampleRate = chunk.sampleRate;
        served++;
        yield chunk;
      }
      log(`TTS: served by mlx sidecar (${served} chunks)`);
      return;
    } catch (err) {
      if (err instanceof Error && err.message === "TTS: synthesis aborted") throw err;
      log(`TTS: sidecar failed (${err instanceof Error ? err.message : String(err)}) — falling back to kokoro-js CPU`);
      await sidecarSupervisor.ensure(); // mark it dead so the next request retries cleanly
    }
  }

  await ensureInitialized();
  for (const s of sentences) {
    if (signal?.aborted) throw new Error("TTS: synthesis aborted");
    const r = await ttsInstance!.generate(s, { voice, speed: rate });
    sampleRate = r.sampling_rate ?? sampleRate;
    if (r.audio && r.audio.length > 0) yield { audio: r.audio, sampleRate, endsSentence: true };
  }
  log("TTS: served by kokoro-js CPU");
}

/** Encode Float32 PCM as a 16-bit mono WAV. Exported for the playback queue. */
export function float32ToWav(samples: Float32Array, sampleRate: number): Buffer {
  const numSamples = samples.length;
  const byteRate = sampleRate * 2;
  const dataSize = numSamples * 2;
  const buf = Buffer.allocUnsafe(44 + dataSize);

  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < numSamples; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }

  return buf;
}

function resolveVoice(voice: string): KokoroVoice {
  const lower = voice.toLowerCase().trim();
  if (lower === "true" || lower === "default" || lower === "") return DEFAULT_VOICE;
  if (KNOWN_VOICES.includes(lower as KokoroVoice)) return lower as KokoroVoice;
  const match = KNOWN_VOICES.find((v) => v.endsWith(`_${lower}`) || v === lower);
  if (match) return match;
  log(`Unknown voice "${voice}", falling back to "${DEFAULT_VOICE}".`);
  return DEFAULT_VOICE;
}
