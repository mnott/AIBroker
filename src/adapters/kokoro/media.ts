/**
 * adapters/kokoro/media.ts — Audio transcription via Whisper CLI.
 *
 * Transport-agnostic: only handles local audio files.
 * Downloading media from WhatsApp/Telegram stays in per-project code.
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

/** Whisper model (overridable via env). */
export const WHISPER_MODEL =
  process.env.AIBROKER_WHISPER_MODEL ?? process.env.MSGBRIDGE_WHISPER_MODEL ?? process.env.WHAZAA_WHISPER_MODEL ?? "small";

/**
 * Map a MIME type to a sensible file extension for images.
 */
export function mimetypeToExt(mimetype: string | null | undefined): string {
  if (!mimetype) return "jpg";
  if (mimetype.includes("png")) return "png";
  if (mimetype.includes("webp")) return "webp";
  if (mimetype.includes("gif")) return "gif";
  return "jpg";
}

/**
 * Map a MIME type to a sensible file extension for documents.
 */
export function mimetypeToDocExt(mimetype: string | null | undefined): string {
  if (!mimetype) return "bin";
  if (mimetype.includes("pdf")) return "pdf";
  if (mimetype.includes("msword")) return "doc";
  if (mimetype.includes("word") || mimetype.includes("docx")) return "docx";
  if (mimetype.includes("spreadsheet") || mimetype.includes("xlsx")) return "xlsx";
  if (mimetype.includes("ms-excel")) return "xls";
  if (mimetype.includes("presentation") || mimetype.includes("pptx")) return "pptx";
  if (mimetype.includes("ms-powerpoint")) return "ppt";
  if (mimetype.includes("zip")) return "zip";
  if (mimetype.includes("text/plain")) return "txt";
  if (mimetype.includes("text/csv")) return "csv";
  if (mimetype.includes("json")) return "json";
  if (mimetype.includes("mp4")) return "mp4";
  if (mimetype.includes("webm")) return "webm";
  if (mimetype.includes("3gpp")) return "3gp";
  return "bin";
}

/**
 * Transcribe a local audio file using the Whisper CLI.
 *
 * @param audioPath - Absolute path to the audio file (WAV, OGG, MP3, etc.)
 * @param label - Label prefix for the transcript (e.g. "[Voice note]" or "[Audio]")
 * @returns Formatted transcript string, or null on failure.
 */
export async function transcribeAudio(
  audioPath: string,
  label = "[Audio]",
): Promise<string | null> {
  const base = audioPath.replace(/\.[^.]+$/, "");
  const baseName = base.split("/").pop()!;

  const filesToClean: string[] = [
    join(tmpdir(), `${baseName}.txt`),
    join(tmpdir(), `${baseName}.json`),
    join(tmpdir(), `${baseName}.vtt`),
    join(tmpdir(), `${baseName}.srt`),
    join(tmpdir(), `${baseName}.tsv`),
  ];

  try {
    log(`Transcribing ${audioPath} (model=${WHISPER_MODEL})...`);

    await execFileAsync(
      WHISPER_BIN,
      [audioPath, "--model", WHISPER_MODEL, "--output_format", "txt", "--output_dir", tmpdir(), "--verbose", "False"],
      {
        timeout: 120_000,
        env: {
          ...process.env,
          PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || "/usr/bin:/bin"}`,
        },
      },
    );

    const txtPath = join(tmpdir(), `${baseName}.txt`);
    if (!existsSync(txtPath)) {
      log(`Whisper did not produce output at ${txtPath}`);
      return null;
    }

    const transcript = readFileSync(txtPath, "utf-8").trim();
    log(`Transcription: ${transcript.slice(0, 80)}`);
    return `${label}: ${transcript}`;
  } catch (err) {
    log(`Audio transcription failed: ${err}`);
    return null;
  } finally {
    for (const f of filesToClean) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
  }
}

/**
 * Split text into chunks suitable for sequential TTS voice notes.
 * Splits at paragraph breaks, then sentence boundaries, then commas,
 * then word boundaries. Guarantees no chunk exceeds maxChars.
 */
export function splitIntoChunks(text: string, maxChars = 400): string[] {
  if (text.length <= maxChars) return [text];

  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    if (current.length + para.length + 2 <= maxChars) {
      current += (current ? "\n\n" : "") + para;
    } else if (para.length <= maxChars) {
      if (current) chunks.push(current);
      current = para;
    } else {
      if (current) chunks.push(current);
      // Split long paragraph at sentence boundaries
      const sentences = para.match(/[^.!?]+[.!?]+\s*/g) ?? [para];
      current = "";
      for (const sentence of sentences) {
        if (current.length + sentence.length <= maxChars) {
          current += sentence;
        } else {
          if (current) chunks.push(current.trim());
          if (sentence.length > maxChars) {
            // Sentence too long — split at commas/word boundaries
            const subs = splitAtBoundaries(sentence, maxChars);
            for (let i = 0; i < subs.length - 1; i++) chunks.push(subs[i]);
            current = subs[subs.length - 1];
          } else {
            current = sentence;
          }
        }
      }
    }
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks;
}

/** Split a long segment at comma boundaries, falling back to word boundaries. */
function splitAtBoundaries(text: string, maxChars: number): string[] {
  // Try comma boundaries first
  const parts = text.split(/,\s*/);
  const chunks: string[] = [];
  let current = "";

  for (const part of parts) {
    const sep = current ? ", " : "";
    if (current.length + sep.length + part.length <= maxChars) {
      current += sep + part;
    } else {
      if (current) chunks.push(current.trim());
      if (part.length > maxChars) {
        // No commas — split at word boundaries
        const words = part.split(/\s+/);
        current = "";
        for (const word of words) {
          if (current.length + word.length + 1 <= maxChars) {
            current += (current ? " " : "") + word;
          } else {
            if (current) chunks.push(current.trim());
            current = word;
          }
        }
      } else {
        current = part;
      }
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}
