/**
 * adapters/kokoro/tts.ts — Kokoro TTS synthesis pipeline.
 *
 * Converts text to OGG Opus audio buffers (for sending as voice notes)
 * or plays locally via afplay. No transport SDK imports.
 *
 * Pipeline: Kokoro-js → Float32 PCM → WAV → ffmpeg → OGG Opus
 */

import { execSync, spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { log } from "../../core/log.js";

const FFMPEG =
  ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "ffmpeg"].find(
    (p) => p === "ffmpeg" || existsSync(p),
  ) ?? "ffmpeg";

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ttsInstance: any | null = null;
let initPromise: Promise<void> | null = null;

async function ensureInitialized(): Promise<void> {
  if (ttsInstance !== null) return;
  if (initPromise !== null) { await initPromise; return; }

  initPromise = (async () => {
    log(`Initializing Kokoro TTS (model: ${MODEL_ID}, dtype: q8)...`);
    const { KokoroTTS } = await import("kokoro-js");
    ttsInstance = await KokoroTTS.from_pretrained(MODEL_ID, { dtype: "q8", device: "cpu" });
    log("Kokoro TTS ready.");
  })();

  await initPromise;
}

/**
 * Convert text to an OGG Opus voice note buffer.
 */
export async function textToVoiceNote(text: string, voice?: string): Promise<Buffer> {
  if (!text?.trim()) throw new Error("TTS: text must not be empty");

  if (FFMPEG === "ffmpeg" && !existsSync("/usr/bin/ffmpeg")) {
    log("Warning: ffmpeg not found at known Homebrew paths; falling back to bare 'ffmpeg'.");
  }

  const resolvedVoice = resolveVoice(voice ?? DEFAULT_VOICE);
  await ensureInitialized();

  log(`Generating audio: voice=${resolvedVoice}, text="${text.slice(0, 60)}${text.length > 60 ? "..." : ""}"`);

  const result = await ttsInstance!.generate(text, { voice: resolvedVoice });
  const combined: Float32Array = result.audio;
  const sampleRate: number = result.sampling_rate ?? 24_000;

  if (combined.length === 0) throw new Error("TTS: generate produced no audio");

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
 * Synthesize text and play locally via afplay.
 */
export async function speakLocally(text: string, voice?: string): Promise<void> {
  if (!text?.trim()) throw new Error("TTS: text must not be empty");

  const resolvedVoice = resolveVoice(voice ?? DEFAULT_VOICE);
  await ensureInitialized();

  log(`Speaking locally: voice=${resolvedVoice}, text="${text.slice(0, 60)}${text.length > 60 ? "..." : ""}"`);

  const speakResult = await ttsInstance!.generate(text, { voice: resolvedVoice });
  const speakAudio: Float32Array = speakResult.audio;
  const speakSampleRate: number = speakResult.sampling_rate ?? 24_000;

  if (speakAudio.length === 0) throw new Error("TTS: generate produced no audio");

  const wavPath = join(tmpdir(), `aibroker-speak-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
  writeFileSync(wavPath, float32ToWav(speakAudio, speakSampleRate));

  const child = spawn("afplay", [wavPath], { stdio: "ignore", detached: true });
  child.on("close", () => {
    try { unlinkSync(wavPath); } catch { /* ignore */ }
  });
  child.unref();
}

export function listVoices(): string[] {
  return [...KNOWN_VOICES];
}

// ── Internal helpers ──

function float32ToWav(samples: Float32Array, sampleRate: number): Buffer {
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
