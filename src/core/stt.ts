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
import { join } from "node:path";
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
  /** POST a WAV to the server, resolve the transcript. */
  serverTranscribe(url: string, wavPath: string): Promise<string>;
  ensureServer(model: string): Promise<string | null>;
  env: NodeJS.ProcessEnv;
  home: string;
}

const PATH_ENV = () => `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || "/usr/bin:/bin"}`;

export const VOICEINK_MODEL_REL = "Library/Application Support/com.prakashjoshipax.VoiceInk/WhisperModels/ggml-large-v3-turbo-q5_0.bin";

/** Model path for whisper.cpp, or null when none is configured/available. */
export function resolveCppModel(d: Pick<SttDeps, "exists" | "env" | "home"> = realDeps): string | null {
  const env = d.env.AIBROKER_WHISPER_CPP_MODEL;
  if (env) return d.exists(env) ? env : null;
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
  const finish = (text: string, backend: SttBackend, model: string): SttResult => {
    const elapsedMs = Date.now() - started;
    log(`[STT] backend=${backend} model=${model} audio=${audioSec ?? "?"}s elapsed=${elapsedMs}ms chars=${text.length}${info ? ` codec=${info.codec}` : ""}`);
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
          if (url) return finish(cleanTranscript(await d.serverTranscribe(url, wav)), "whisper-server", modelName);
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

export function stopWhisperServer(): void {
  if (serverProc) { try { serverProc.kill(); } catch { /* ignore */ } }
  serverProc = null;
  serverUrl = null;
  serverModel = null;
}

async function postWav(url: string, wavPath: string): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([readFileSync(wavPath)], { type: "audio/wav" }), "audio.wav");
  form.append("response_format", "json");
  form.append("language", "auto");
  form.append("temperature", "0.0");
  const r = await fetch(`${url}/inference`, { method: "POST", body: form, signal: AbortSignal.timeout(120_000) });
  if (!r.ok) throw new Error(`whisper-server HTTP ${r.status}`);
  const j = (await r.json()) as { text?: string; error?: string };
  if (j.error) throw new Error(`whisper-server: ${j.error}`);
  return j.text ?? "";
}

export const realDeps: SttDeps = {
  exists: existsSync,
  run: async (bin, args, timeout) => {
    const { stdout } = await execFileP(bin, args, { timeout, env: { ...process.env, PATH: PATH_ENV() }, maxBuffer: 8 * 1024 * 1024 });
    return String(stdout);
  },
  readText: (p) => readFileSync(p, "utf-8"),
  remove: (p) => unlinkSync(p),
  serverTranscribe: postWav,
  ensureServer: (m) => ensureWhisperServer(m),
  env: process.env,
  home: homedir(),
};

process.on("exit", stopWhisperServer);

let keepWarmTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start whisper-server now (daemon start) and keep it resident: a periodic
 * health check restarts it if it died or stopped answering.
 */
export function prewarmWhisperServer(env: NodeJS.ProcessEnv = process.env): void {
  const model = resolveCppModel();
  if (!model || env.AIBROKER_STT_PREWARM === "0") return;
  void ensureWhisperServer(model, env).catch((e) => log(`[STT] prewarm failed: ${e}`));
  if (keepWarmTimer) return;
  keepWarmTimer = setInterval(async () => {
    if (starting) return;
    try {
      if (serverProc && serverUrl && serverProc.exitCode === null) {
        const r = await fetch(`${serverUrl}/`, { signal: AbortSignal.timeout(3000) });
        if (r.status < 500) return;
      }
    } catch { /* unhealthy */ }
    log("[STT] whisper-server unhealthy, restarting");
    stopWhisperServer();
    await ensureWhisperServer(model, env).catch(() => null);
  }, 30_000);
  keepWarmTimer.unref();
}
