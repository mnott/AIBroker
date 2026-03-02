/**
 * adapters/iterm/dictation.ts — Local mic recording and Whisper transcription.
 *
 * Provides recordFromMic() and transcribeLocalAudio() for desk dictation.
 * Both functions use sox for recording and the Whisper CLI for transcription.
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";

import { log } from "../../core/log.js";

const execFileAsync = promisify(execFile);

/** Absolute path to the Whisper CLI binary. */
export const WHISPER_BIN =
  ["/opt/homebrew/bin/whisper", "/usr/local/bin/whisper", "whisper"].find(
    (p) => p === "whisper" || existsSync(p),
  ) ?? "whisper";

/** Whisper model name (overridable via AIBROKER_WHISPER_MODEL env). */
export const WHISPER_MODEL = process.env.AIBROKER_WHISPER_MODEL ?? process.env.MSGBRIDGE_WHISPER_MODEL ?? process.env.WHAZAA_WHISPER_MODEL ?? "small";

/** Absolute path to the sox binary. */
const SOX_BIN =
  ["/opt/homebrew/bin/sox", "/usr/local/bin/sox", "sox"].find(
    (p) => p === "sox" || existsSync(p),
  ) ?? "sox";

/**
 * Record audio from the default Mac microphone using sox.
 * Stops automatically after ~2 seconds of silence.
 *
 * @param maxDurationSec - Maximum recording duration (default 60s).
 * @returns Absolute path to the recorded WAV file.
 */
export async function recordFromMic(maxDurationSec = 60): Promise<string> {
  const wavPath = join(tmpdir(), `aibroker-dictation-${Date.now()}.wav`);

  // Audible start indicator
  execFile("afplay", ["/System/Library/Sounds/Tink.aiff"], () => {});

  log(`Dictation: recording to ${wavPath} (max ${maxDurationSec}s)...`);

  try {
    await execFileAsync(
      SOX_BIN,
      [
        "-d", "-r", "16000", "-c", "1", "-b", "16",
        wavPath,
        "silence", "1", "0.2", "1%", "1", "2.0", "1%",
      ],
      {
        timeout: maxDurationSec * 1000,
        env: {
          ...process.env,
          PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || "/usr/bin:/bin"}`,
        },
      },
    );
  } catch (err: unknown) {
    if (!existsSync(wavPath)) {
      throw new Error(`Recording failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    log("Dictation: sox exited (likely timeout/silence stop) — file exists, continuing.");
  }

  // Audible stop indicator
  execFile("afplay", ["/System/Library/Sounds/Pop.aiff"], () => {});

  log(`Dictation: recorded ${wavPath}`);
  return wavPath;
}

/**
 * Transcribe a local audio file using the Whisper CLI.
 *
 * @param audioPath - Absolute path to the audio file.
 * @returns The raw transcript text.
 */
export async function transcribeLocalAudio(audioPath: string): Promise<string> {
  const base = audioPath.replace(/\.[^.]+$/, "");
  const baseName = base.split("/").pop()!;
  const outDir = tmpdir();

  const filesToClean: string[] = [
    join(outDir, `${baseName}.txt`),
    join(outDir, `${baseName}.json`),
    join(outDir, `${baseName}.vtt`),
    join(outDir, `${baseName}.srt`),
    join(outDir, `${baseName}.tsv`),
  ];

  try {
    log(`Dictation: transcribing ${audioPath} (model=${WHISPER_MODEL})...`);

    await execFileAsync(
      WHISPER_BIN,
      [audioPath, "--model", WHISPER_MODEL, "--output_format", "txt", "--output_dir", outDir, "--verbose", "False"],
      {
        timeout: 120_000,
        env: {
          ...process.env,
          PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || "/usr/bin:/bin"}`,
        },
      },
    );

    const txtPath = join(outDir, `${baseName}.txt`);
    if (!existsSync(txtPath)) {
      throw new Error(`Whisper did not produce output at ${txtPath}`);
    }

    const transcript = readFileSync(txtPath, "utf-8").trim();
    log(`Dictation: transcript (${transcript.length} chars): ${transcript.slice(0, 80)}`);
    return transcript;
  } finally {
    for (const f of filesToClean) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
  }
}
