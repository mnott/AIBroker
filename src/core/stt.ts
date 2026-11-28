/**
 * core/stt.ts — the single speech-to-text module (PAILot voice notes,
 * WhatsApp/Telegram transcribe, local dictation).
 *
 * Backend order: whisper.cpp `whisper-server` (persistent, model loaded once,
 * Metal) -> `whisper-cli` per call -> Python `whisper`. Audio is converted to
 * 16 kHz mono WAV with ffmpeg for the whisper.cpp backends. Language is
 * auto-detected. Models are never downloaded; the VoiceInk model is reused
 * read-only when present.
 *
 * Env: AIBROKER_WHISPER_CPP_MODEL (model path), AIBROKER_WHISPER_SERVER_HOST
 * (default 127.0.0.1), AIBROKER_WHISPER_SERVER_PORT (default 8178),
 * AIBROKER_WHISPER_MODEL (Python model name, default "small").
 */

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { resolveBin, resolveFfmpegBin, resolveWhisperBin } from "./bins.js";
import { log } from "./log.js";

const execFileP = promisify(execFile);

export type SttBackend = "whisper-server" | "whisper-cli" | "python-whisper";

export interface SttResult {
  text: string;
  backend: SttBackend;
  model: string;
  audioSec: number | null;
  elapsedMs: number;
  /** Set when the clip was judged non-speech (text is then empty). */
  noSpeech?: boolean;
  /** Detected/used language (whisper-server path only). */
  lang?: string;
}

export interface DetectResult { lang: string; prob: number }
export interface DecodeResult { text: string; avgLogprob: number; /** max segment no_speech_prob, when the server reports it */ noSpeechProb?: number }

export interface WavStats { rms: number; speechRatio: number }

/** Signal check on 16 kHz mono s16le WAV: overall RMS (0..1) and share of 30 ms frames above a speech floor. */
export function wavStats(buf: Buffer): WavStats | null {
  if (buf.length < 44 + 2) return null;
  const n = Math.floor((buf.length - 44) / 2);
  const frame = 480;
  let sum = 0, frames = 0, loud = 0;
  for (let f = 0; f + frame <= n; f += frame) {
    let fs = 0;
    for (let i = 0; i < frame; i++) { const v = buf.readInt16LE(44 + (f + i) * 2) / 32768; fs += v * v; }
    sum += fs; frames++;
    if (Math.sqrt(fs / frame) > SPEECH_FRAME_RMS) loud++;
  }
  if (!frames) return null;
  return { rms: Math.sqrt(sum / (frames * frame)), speechRatio: loud / frames };
}

export const SPEECH_FRAME_RMS = 0.01;
const LOW_RMS = 0.012;
const LOW_SPEECH_RATIO = 0.12;

const HALLUCINATIONS = [
  /^thank(s| you)( so much)?( for (watching|listening))?[.!]*$/i,
  /^thanks for watching[.!]*$/i,
  /^you[.!]*$/i,
  /^(bye|goodbye)[.!]*$/i,
  /^vielen dank( fürs? (zuschauen|zuhören))?[.!]*$/i,
  /^danke( fürs? (zuschauen|zuhören))?[.!]*$/i,
  /^untertitel.*$/i,
  /^merci( d'avoir regardé.*)?[.!]*$/i,
  /^sous-?titr.*$/i,
  /^dziękuję( za uwagę| za oglądanie)?[.!]*$/i,
  /^napisy.*$/i,
];

/** Punctuation-only text or a known Whisper filler hallucination (de/en/fr/pl). */
export function isHallucination(text: string): boolean {
  const t = text.trim();
  if (!/[\p{L}\p{N}]/u.test(t)) return true;
  return HALLUCINATIONS.some((re) => re.test(t));
}

export interface NoSpeechInput { text: string; avgLogprob: number | null; nsp?: number; langProb: number | null; stats: WavStats | null }

/** Drop only when the signal check AND the model confidence agree. */
export function judgeNoSpeech(i: NoSpeechInput): boolean {
  if (!i.stats) return false;
  const signalLow = i.stats.rms < LOW_RMS || i.stats.speechRatio < LOW_SPEECH_RATIO;
  if (!signalLow) return false;
  const lp = i.avgLogprob ?? 0;
  const nsp = i.nsp ?? 0;
  const modelLow = nsp > 0.6 || lp < -1.0 || (i.langProb !== null && i.langProb < 0.5) ||
    (isHallucination(i.text) && (nsp > 0.3 || lp < -0.5 || (i.langProb !== null && i.langProb < 0.7)));
  return modelLow;
}

const NO_SPEECH_REPLY: Record<string, string> = {
  de: "Nichts erkannt – bitte nochmal",
  en: "Nothing recognised – please try again",
  fr: "Rien reconnu – veuillez réessayer",
  pl: "Nic nie rozpoznano – spróbuj ponownie",
};
export function noSpeechReply(lang?: string): string {
  return NO_SPEECH_REPLY[lang ?? "en"] ?? NO_SPEECH_REPLY.en;
}

export const DEFAULT_STT_LANGS = "de,en,fr,pl";

/** Allowed transcription languages (AIBROKER_STT_LANGS, comma list of ISO codes). */
export function allowedLangs(env: NodeJS.ProcessEnv = process.env): string[] {
  const l = (env.AIBROKER_STT_LANGS ?? DEFAULT_STT_LANGS).split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  return l.length ? l : DEFAULT_STT_LANGS.split(",");
}

/**
 * Transcribe restricted to the allowed set: detect once; if the detected language
 * is allowed decode with it, otherwise decode with each allowed language and keep
 * the best avg_logprob. Never returns a language outside the set.
 */
export async function transcribeRestricted(
  url: string, wav: string, langs: string[],
  d: Pick<SttDeps, "serverDetect" | "serverDecode">,
): Promise<{ text: string; lang: string; prob: number | null; detected: string; avgLogprob: number; noSpeechProb?: number }> {
  const det = await d.serverDetect(url, wav);
  if (langs.includes(det.lang)) {
    const r = await d.serverDecode(url, wav, det.lang);
    return { text: r.text, lang: det.lang, prob: det.prob, detected: det.lang, avgLogprob: r.avgLogprob, noSpeechProb: r.noSpeechProb };
  }
  let best: { text: string; lang: string; lp: number; nsp?: number } | null = null;
  for (const lang of langs) {
    const r = await d.serverDecode(url, wav, lang);
    if (!best || r.avgLogprob > best.lp) best = { text: r.text, lang, lp: r.avgLogprob, nsp: r.noSpeechProb };
  }
  return { text: best!.text, lang: best!.lang, prob: null, detected: det.lang, avgLogprob: best!.lp, noSpeechProb: best!.nsp };
}

export interface AudioInfo {
  durationSec: number;
  codec: string;
}

export class SttAudioError extends Error {}

/** Everything touching the outside world, replaceable in tests. */
export interface SttDeps {
  exists(path: string): boolean;
  /** Run a binary, resolve stdout. */
  run(bin: string, args: string[], timeoutMs: number): Promise<string>;
  readText(path: string): string;
  remove(path: string): void;
  /** Language-ID pass only (no decoding): ISO code + probability of the top language. */
  serverDetect(url: string, wavPath: string): Promise<DetectResult>;
  /** Decode with a forced language; avgLogprob is the mean segment avg_logprob. */
  serverDecode(url: string, wavPath: string, lang: string): Promise<DecodeResult>;
  ensureServer(model: string): Promise<string | null>;
  /** Energy stats of the decoded WAV; null when unreadable. Optional (tests). */
  wavStats?(wavPath: string): WavStats | null;
  env: NodeJS.ProcessEnv;
  home: string;
}

const PATH_ENV = () => `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || "/usr/bin:/bin"}`;

export const VOICEINK_MODEL_REL = "Library/Application Support/com.prakashjoshipax.VoiceInk/WhisperModels/ggml-large-v3-turbo-q5_0.bin";

/** modelId from ~/.pai/dictation.json (written by the PAI menu bar app), or null. */
function dictationModelId(d: Pick<SttDeps, "exists" | "home"> & Partial<Pick<SttDeps, "readText">>): string | null {
  const p = join(d.home, ".pai/dictation.json");
  try {
    if (!d.exists(p)) return null;
    const j = JSON.parse((d.readText ?? ((x: string) => readFileSync(x, "utf-8")))(p));
    const id = j?.modelId;
    return typeof id === "string" && /^[A-Za-z0-9._-]+$/.test(id) ? id : null;
  } catch { return null; }
}

/** Model path for whisper.cpp, or null when none is configured/available. */
export function resolveCppModel(d: Pick<SttDeps, "exists" | "env" | "home"> & Partial<Pick<SttDeps, "readText">> = realDeps): string | null {
  const env = d.env.AIBROKER_WHISPER_CPP_MODEL;
  if (env) return d.exists(env) ? env : null;
  const voiceinkDir = join(d.home, dirname(VOICEINK_MODEL_REL));
  const id = dictationModelId(d);
  if (id) {
    for (const dir of [join(d.home, ".pai/models/whisper"), join(d.home, ".cache/aibroker-stt"), voiceinkDir]) {
      const f = join(dir, `ggml-${id}.bin`);
      if (d.exists(f)) return f;
    }
  }
  const voiceink = join(d.home, VOICEINK_MODEL_REL);
  if (d.exists(voiceink)) return voiceink;
  const cacheDir = join(d.home, ".cache/aibroker-stt");
  try {
    const f = readdirSync(cacheDir).find((n) => /^ggml-.*\.bin$/.test(n));
    if (f) return join(cacheDir, f);
  } catch { /* none */ }
  return null;
}

export function wavConvertArgs(input: string, output: string): string[] {
  return ["-y", "-loglevel", "error", "-i", input, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", output];
}

export function cliArgs(model: string, wav: string, outBase: string): string[] {
  return ["-m", model, "-f", wav, "-l", "auto", "-nt", "-otxt", "-of", outBase];
}

export function serverArgs(model: string, host: string, port: number): string[] {
  return ["-m", model, "--host", host, "--port", String(port), "-l", "auto", "-nt"];
}

export function pythonArgs(audio: string, model: string, outDir: string): string[] {
  return [audio, "--model", model, "--output_format", "txt", "--output_dir", outDir, "--verbose", "False"];
}

export async function probeAudio(path: string, d: Pick<SttDeps, "run">): Promise<AudioInfo> {
  const out = await d.run(
    resolveBin("ffprobe"),
    ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_name:format=duration", "-of", "json", path],
    15_000,
  );
  let j: { streams?: { codec_name?: string }[]; format?: { duration?: string } };
  try { j = JSON.parse(out); } catch { throw new SttAudioError("ffprobe returned unparsable output"); }
  const codec = j.streams?.[0]?.codec_name;
  if (!codec) throw new SttAudioError("no audio stream in file");
  const durationSec = Number(j.format?.duration);
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new SttAudioError("audio has no duration");
  return { durationSec, codec };
}

const MIN_AUDIO_SEC = 0.3;

/** Transcript cleanup: whisper.cpp marks silence with bracketed tokens. */
export function cleanTranscript(raw: string): string {
  return raw.replace(/\[(BLANK_AUDIO|MUSIC|SILENCE)\]/gi, "").replace(/\s+/g, " ").trim();
}

export async function transcribeFile(audioPath: string, d: SttDeps = realDeps): Promise<SttResult> {
  if (!d.exists(audioPath)) throw new SttAudioError(`audio file missing: ${audioPath}`);
  let info: AudioInfo | null = null;
  try {
    info = await probeAudio(audioPath, d);
  } catch (err) {
    if (err instanceof SttAudioError) throw err;
    log(`[STT] ffprobe unavailable (${err instanceof Error ? err.message : err}); continuing without validation`);
  }
  if (info && info.durationSec < MIN_AUDIO_SEC) {
    throw new SttAudioError(`audio too short (${info.durationSec.toFixed(2)}s, codec ${info.codec})`);
  }
  const audioSec = info ? Math.round(info.durationSec * 10) / 10 : null;

  const started = Date.now();
  const id = `aibroker-stt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const wav = join(tmpdir(), `${id}.wav`);
  const cleanup: string[] = [wav, join(tmpdir(), `${id}.txt`)];
  let langNote = "";
  let noSpeechInfo: { rms: number; nsp: number | undefined; lang: string } | null = null;
  const finish = (text: string, backend: SttBackend, model: string): SttResult => {
    const elapsedMs = Date.now() - started;
    if (noSpeechInfo) {
      log(`[STT] no speech: audio=${audioSec ?? "?"}s rms=${noSpeechInfo.rms.toFixed(4)} nsp=${noSpeechInfo.nsp?.toFixed(2) ?? "?"} text=${JSON.stringify(text)}${langNote}`);
      return { text: "", backend, model, audioSec, elapsedMs, noSpeech: true, lang: noSpeechInfo.lang };
    }
    log(`[STT] backend=${backend} model=${model} audio=${audioSec ?? "?"}s elapsed=${elapsedMs}ms chars=${text.length}${info ? ` codec=${info.codec}` : ""}${langNote}`);
    return { text, backend, model, audioSec, elapsedMs };
  };

  try {
    const cppModel = resolveCppModel(d);
    if (cppModel) {
      const modelName = cppModel.split("/").pop()!;
      let wavOk = false;
      try {
        await d.run(resolveFfmpegBin(), wavConvertArgs(audioPath, wav), 30_000);
        wavOk = d.exists(wav);
      } catch (err) {
        log(`[STT] ffmpeg conversion failed: ${err instanceof Error ? err.message : err}`);
      }
      if (wavOk) {
        try {
          const url = await d.ensureServer(cppModel);
          if (url) {
            const r = await transcribeRestricted(url, wav, allowedLangs(d.env), d);
            langNote = ` lang=${r.lang} detected=${r.detected}${r.prob !== null ? ` p=${r.prob.toFixed(3)}` : " (out-of-set, best avg_logprob)"}`;
            const text = cleanTranscript(r.text);
            const stats = d.wavStats ? d.wavStats(wav) : null;
            if (text && stats && judgeNoSpeech({ text, avgLogprob: r.avgLogprob, nsp: r.noSpeechProb, langProb: r.prob, stats })) {
              noSpeechInfo = { rms: stats.rms, nsp: r.noSpeechProb, lang: r.lang };
            }
            const res = finish(text, "whisper-server", modelName);
            return noSpeechInfo ? res : { ...res, lang: r.lang };
          }
        } catch (err) {
          log(`[STT] whisper-server failed: ${err instanceof Error ? err.message : err}`);
        }
        try {
          const outBase = join(tmpdir(), id);
          await d.run(resolveBin("whisper-cli"), cliArgs(cppModel, wav, outBase), 120_000);
          const txt = `${outBase}.txt`;
          if (d.exists(txt)) return finish(cleanTranscript(d.readText(txt)), "whisper-cli", modelName);
          log("[STT] whisper-cli produced no output");
        } catch (err) {
          log(`[STT] whisper-cli failed: ${err instanceof Error ? err.message : err}`);
        }
      }
    }

    const pyModel = d.env.AIBROKER_WHISPER_MODEL ?? d.env.MSGBRIDGE_WHISPER_MODEL ?? d.env.WHAZAA_WHISPER_MODEL ?? "small";
    const base = audioPath.replace(/\.[^.]+$/, "").split("/").pop()!;
    for (const ext of ["txt", "json", "vtt", "srt", "tsv"]) cleanup.push(join(tmpdir(), `${base}.${ext}`));
    await d.run(resolveWhisperBin(), pythonArgs(audioPath, pyModel, tmpdir()), 120_000);
    const txt = join(tmpdir(), `${base}.txt`);
    if (!d.exists(txt)) throw new Error("python whisper produced no output");
    return finish(cleanTranscript(d.readText(txt)), "python-whisper", pyModel);
  } finally {
    for (const f of cleanup) { try { d.remove(f); } catch { /* ignore */ } }
  }
}

// ── whisper-server lifecycle ──

let serverProc: ChildProcess | null = null;
let serverUrl: string | null = null;
let serverModel: string | null = null;
let starting: Promise<string | null> | null = null;

function serverEndpoint(env: NodeJS.ProcessEnv): { host: string; port: number } {
  const port = Number(env.AIBROKER_WHISPER_SERVER_PORT ?? 8178);
  return { host: env.AIBROKER_WHISPER_SERVER_HOST ?? "127.0.0.1", port: Number.isInteger(port) && port > 0 ? port : 8178 };
}

async function waitHealthy(url: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!serverProc) return false;
    try {
      const r = await fetch(`${url}/`, { signal: AbortSignal.timeout(1500) });
      if (r.status < 500) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/** Start whisper-server lazily; resolves its base URL, or null if unavailable. */
export async function ensureWhisperServer(model: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (serverProc && serverUrl && serverModel === model && serverProc.exitCode === null) return serverUrl;
  if (starting) return starting;
  starting = (async () => {
    stopWhisperServer();
    const bin = resolveBin("whisper-server");
    if (bin === "whisper-server" && !existsSync(bin)) return null;
    const { host, port } = serverEndpoint(env);
    const url = `http://${host}:${port}`;
    const child = spawn(bin, serverArgs(model, host, port), {
      stdio: ["ignore", "ignore", "ignore"],
      env: { ...process.env, PATH: PATH_ENV() },
    });
    serverProc = child;
    serverModel = model;
    child.on("exit", () => { if (serverProc === child) { serverProc = null; serverUrl = null; } });
    child.on("error", () => { if (serverProc === child) { serverProc = null; serverUrl = null; } });
    if (!(await waitHealthy(url, 60_000))) {
      stopWhisperServer();
      return null;
    }
    serverUrl = url;
    log(`[STT] whisper-server up at ${url} (model ${model.split("/").pop()})`);
    return url;
  })().finally(() => { starting = null; });
  return starting;
}

/**
 * Restart the resident whisper-server when the configured model (env /
 * dictation.json) no longer matches the one it runs. No-op when no server is
 * running. Returns true when a restart was triggered.
 */
export async function syncWhisperServerModel(
  env: NodeJS.ProcessEnv = process.env,
  deps: Pick<SttDeps, "exists" | "home"> & Partial<Pick<SttDeps, "readText">> = realDeps,
  ensure: (model: string, env: NodeJS.ProcessEnv) => Promise<string | null> = ensureWhisperServer,
): Promise<boolean> {
  if (!serverProc || serverProc.exitCode !== null || starting) return false;
  const model = resolveCppModel({ exists: deps.exists, home: deps.home, readText: deps.readText, env });
  if (!model || model === serverModel) return false;
  log(`[STT] dictation model changed, restarting whisper-server (${model.split("/").pop()})`);
  await ensure(model, env).catch(() => null);
  return true;
}

export function stopWhisperServer(): void {
  if (serverProc) { try { serverProc.kill(); } catch { /* ignore */ } }
  serverProc = null;
  serverUrl = null;
  serverModel = null;
}

async function postInference(url: string, wavPath: string, fields: Record<string, string>): Promise<any> {
  const form = new FormData();
  form.append("file", new Blob([readFileSync(wavPath)], { type: "audio/wav" }), "audio.wav");
  form.append("response_format", "verbose_json");
  form.append("temperature", "0.0");
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const r = await fetch(`${url}/inference`, { method: "POST", body: form, signal: AbortSignal.timeout(120_000) });
  if (!r.ok) throw new Error(`whisper-server HTTP ${r.status}`);
  const j = (await r.json()) as any;
  if (j.error) throw new Error(`whisper-server: ${j.error}`);
  return j;
}

async function postDetect(url: string, wavPath: string): Promise<DetectResult> {
  const j = await postInference(url, wavPath, { language: "auto", detect_language: "true" });
  const probs = (j.language_probabilities ?? {}) as Record<string, number>;
  const [code] = Object.keys(probs);
  return { lang: code ?? String(j.detected_language ?? ""), prob: Number(j.detected_language_probability ?? 0) };
}

async function postDecode(url: string, wavPath: string, lang: string): Promise<DecodeResult> {
  const j = await postInference(url, wavPath, { language: lang });
  const segs = (j.segments ?? []) as Array<{ avg_logprob?: number; no_speech_prob?: number }>;
  const nsps = segs.map((x) => x.no_speech_prob).filter((x): x is number => typeof x === "number");
  const lps = segs.map((x) => x.avg_logprob).filter((x): x is number => typeof x === "number");
  return { text: String(j.text ?? ""), avgLogprob: lps.length ? lps.reduce((a, b) => a + b, 0) / lps.length : -Infinity, noSpeechProb: nsps.length ? Math.max(...nsps) : undefined };
}

export const realDeps: SttDeps = {
  exists: existsSync,
  run: async (bin, args, timeout) => {
    const { stdout } = await execFileP(bin, args, { timeout, env: { ...process.env, PATH: PATH_ENV() }, maxBuffer: 8 * 1024 * 1024 });
    return String(stdout);
  },
  readText: (p) => readFileSync(p, "utf-8"),
  remove: (p) => unlinkSync(p),
  serverDetect: postDetect,
  serverDecode: postDecode,
  ensureServer: (m) => ensureWhisperServer(m),
  wavStats: (p) => { try { return wavStats(readFileSync(p)); } catch { return null; } },
  env: process.env,
  home: homedir(),
};

process.on("exit", stopWhisperServer);

export interface KeepWarmDeps {
  isStarting: () => boolean;
  syncModel: (env: NodeJS.ProcessEnv) => Promise<boolean>;
  /** true when a live server answers healthily */
  healthy: () => Promise<boolean>;
  stop: () => void;
  ensure: (model: string, env: NodeJS.ProcessEnv) => Promise<string | null>;
  resolveModel: () => string | null;
}
const realKeepWarmDeps: KeepWarmDeps = {
  isStarting: () => !!starting,
  syncModel: (env) => syncWhisperServerModel(env).catch(() => false),
  healthy: async () => {
    try {
      if (serverProc && serverUrl && serverProc.exitCode === null) {
        const r = await fetch(`${serverUrl}/`, { signal: AbortSignal.timeout(3000) });
        if (r.status < 500) return true;
      }
    } catch { /* unhealthy */ }
    return false;
  },
  stop: () => stopWhisperServer(),
  ensure: (m, e) => ensureWhisperServer(m, e),
  resolveModel: () => resolveCppModel(),
};

/** One keep-warm health check; restarts whisper-server when unhealthy. Deps injectable for tests. */
export async function keepWarmTick(env: NodeJS.ProcessEnv, model: string, deps: KeepWarmDeps = realKeepWarmDeps): Promise<void> {
  if (deps.isStarting()) return;
  await deps.syncModel(env);
  if (deps.isStarting()) return;
  if (await deps.healthy()) return;
  log("[STT] whisper-server unhealthy, restarting");
  deps.stop();
  await deps.ensure(deps.resolveModel() ?? model, env).catch(() => null);
}

let keepWarmTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start whisper-server now (daemon start) and keep it resident: a periodic
 * health check restarts it if it died or stopped answering.
 */
export function prewarmWhisperServer(env: NodeJS.ProcessEnv = process.env): void {
  const model0 = resolveCppModel();
  if (!model0 || env.AIBROKER_STT_PREWARM === "0") return;
  const model = model0;
  void ensureWhisperServer(model, env).catch((e) => log(`[STT] prewarm failed: ${e}`));
  if (keepWarmTimer) return;
  keepWarmTimer = setInterval(() => { void keepWarmTick(env, model); }, 30_000);
  keepWarmTimer.unref();
}
