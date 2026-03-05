/**
 * daemon/vision.ts — Image and video understanding.
 *
 * Image analysis: Delivered to the active Claude Code session via iTerm2.
 * The image is written to a temp file, and the path is typed into the session
 * so Claude's built-in Read tool can analyze it. Covered by Max plan.
 *
 * Video analysis: Google Gemini 2.0 Flash REST API (free tier: 15 RPM, 1M tokens/day).
 * Only model with native video understanding — no frame extraction needed.
 *
 * Requires GEMINI_API_KEY for video analysis (free tier available).
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../core/log.js";

/** Directory for received media files. */
const MEDIA_DIR = join(homedir(), ".aibroker", "media");

interface SaveImageResult {
  path: string;
  sizeBytes: number;
}

/**
 * Save a received image to disk and return the path.
 * The path can be typed into an active Claude Code session for analysis.
 */
export function saveReceivedImage(imageBuffer: Buffer, mimetype?: string): SaveImageResult {
  mkdirSync(MEDIA_DIR, { recursive: true });
  const ext = mimeToExt(mimetype ?? "image/png");
  const filename = `img-${Date.now()}.${ext}`;
  const path = join(MEDIA_DIR, filename);
  writeFileSync(path, imageBuffer);
  log(`Vision: saved image (${imageBuffer.length} bytes) to ${path}`);
  return { path, sizeBytes: imageBuffer.length };
}

/**
 * Save a received video to disk and return the path.
 */
export function saveReceivedVideo(videoBuffer: Buffer, mimetype?: string): SaveImageResult {
  mkdirSync(MEDIA_DIR, { recursive: true });
  const ext = mimeToExt(mimetype ?? "video/mp4");
  const filename = `vid-${Date.now()}.${ext}`;
  const path = join(MEDIA_DIR, filename);
  writeFileSync(path, videoBuffer);
  log(`Vision: saved video (${videoBuffer.length} bytes) to ${path}`);
  return { path, sizeBytes: videoBuffer.length };
}

// ── Video Analysis (Gemini 2.0 Flash — free tier) ──

const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_VIDEO_MODEL = "gemini-2.0-flash";

interface AnalyzeVideoOptions {
  videoBuffer: Buffer;
  mimetype?: string;
  prompt?: string;
  model?: string;
}

interface AnalyzeResult {
  text: string;
  model: string;
  durationMs: number;
}

/**
 * Analyze a video using Gemini's native video understanding.
 * Free tier: 15 requests/minute, 1M tokens/day.
 *
 * Used as a fallback when no active Claude Code session is available,
 * or for direct video analysis requests.
 */
export async function analyzeVideo(opts: AnalyzeVideoOptions): Promise<AnalyzeResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY not set. Get a free key at https://aistudio.google.com/app/apikey");
  }

  const model = opts.model ?? DEFAULT_VIDEO_MODEL;
  const mimetype = opts.mimetype ?? "video/mp4";
  const prompt = opts.prompt ?? "Describe what is happening in this video.";
  const startMs = Date.now();
  const sizeBytes = opts.videoBuffer.length;

  log(`Vision: analyzing video (${sizeBytes} bytes, ${mimetype}) with ${model}`);

  let fileUri: string | undefined;

  if (sizeBytes > 20 * 1024 * 1024) {
    fileUri = await uploadToGeminiFileApi(opts.videoBuffer, mimetype, apiKey);
  }

  const parts: unknown[] = [];

  if (fileUri) {
    parts.push({
      fileData: { mimeType: mimetype, fileUri },
    });
  } else {
    parts.push({
      inlineData: { mimeType: mimetype, data: opts.videoBuffer.toString("base64") },
    });
  }

  parts.push({ text: prompt });

  const generateUrl = `${GEMINI_API_URL}/models/${model}:generateContent?key=${apiKey}`;

  const res = await fetch(generateUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts }],
      generationConfig: { maxOutputTokens: 1024 },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error (${res.status}): ${errText}`);
  }

  const data = await res.json() as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
    }>;
  };

  const text = data.candidates?.[0]?.content?.parts
    ?.filter((p) => p.text)
    .map((p) => p.text)
    .join("\n") ?? "";

  const durationMs = Date.now() - startMs;
  log(`Vision: video analysis completed in ${durationMs}ms`);

  return { text, model, durationMs };
}

async function uploadToGeminiFileApi(
  buffer: Buffer,
  mimetype: string,
  apiKey: string,
): Promise<string> {
  const startUrl = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`;

  const startRes = await fetch(startUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(buffer.length),
      "X-Goog-Upload-Header-Content-Type": mimetype,
    },
    body: JSON.stringify({
      file: { displayName: `aibroker-upload-${Date.now()}` },
    }),
  });

  if (!startRes.ok) {
    throw new Error(`Gemini File API start failed (${startRes.status}): ${await startRes.text()}`);
  }

  const uploadUrl = startRes.headers.get("X-Goog-Upload-URL");
  if (!uploadUrl) {
    throw new Error("Gemini File API did not return an upload URL");
  }

  const uploadRes = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Length": String(buffer.length),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: buffer,
  });

  if (!uploadRes.ok) {
    throw new Error(`Gemini File API upload failed (${uploadRes.status}): ${await uploadRes.text()}`);
  }

  const fileData = await uploadRes.json() as { file?: { uri?: string; state?: string } };
  const uri = fileData.file?.uri;
  if (!uri) {
    throw new Error("Gemini File API did not return a file URI");
  }

  if (fileData.file?.state === "PROCESSING") {
    await waitForGeminiFile(uri, apiKey);
  }

  return uri;
}

async function waitForGeminiFile(uri: string, apiKey: string, maxWaitMs = 120_000): Promise<void> {
  const startMs = Date.now();
  while (Date.now() - startMs < maxWaitMs) {
    await new Promise((r) => setTimeout(r, 2000));

    const res = await fetch(`${uri}?key=${apiKey}`);
    if (!res.ok) continue;

    const data = await res.json() as { state?: string };
    if (data.state === "ACTIVE") return;
    if (data.state === "FAILED") throw new Error("Gemini file processing failed");
  }
  throw new Error(`Gemini file processing timed out after ${maxWaitMs}ms`);
}

// ── Helpers ──

function mimeToExt(mime: string): string {
  const map: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
  };
  return map[mime] ?? "bin";
}
