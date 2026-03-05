/**
 * daemon/vision.ts — Image and video understanding.
 *
 * Image analysis: Uses Claude Code subprocess via Agent SDK (covered by Max plan).
 * The image is written to a temp file, and Claude Code's Read tool analyzes it.
 *
 * Video analysis: Google Gemini 2.0 Flash REST API (free tier: 15 RPM, 1M tokens/day).
 * Only model with native video understanding — no frame extraction needed.
 *
 * No separate API keys needed for image analysis (uses Max plan).
 * Requires GEMINI_API_KEY for video analysis (free tier available).
 */

import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { log } from "../core/log.js";

interface AnalyzeResult {
  text: string;
  model: string;
  durationMs: number;
}

// ── Image Analysis (Claude Code via Agent SDK — Max plan) ──

interface AnalyzeImageOptions {
  imageBuffer: Buffer;
  mimetype?: string;
  prompt?: string;
}

/**
 * Analyze an image using Claude Code subprocess (covered by Max plan).
 *
 * Writes the image to a temp file, spawns Claude Code via Agent SDK,
 * which reads the image using its built-in Read tool.
 */
export async function analyzeImage(opts: AnalyzeImageOptions): Promise<AnalyzeResult> {
  const ext = mimeToExt(opts.mimetype ?? "image/png");
  const tmpPath = join(tmpdir(), `aibroker-vision-${Date.now()}.${ext}`);
  const prompt = opts.prompt ?? "Describe this image in detail.";
  const startMs = Date.now();

  log(`Vision: analyzing image (${opts.imageBuffer.length} bytes) via Claude Code`);

  writeFileSync(tmpPath, opts.imageBuffer);

  try {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    const cleanEnv = { ...process.env };
    delete cleanEnv.CLAUDECODE;
    cleanEnv.IS_SANDBOX = "1";
    if (!cleanEnv.PATH?.includes(".local/bin")) {
      cleanEnv.PATH = `${homedir()}/.local/bin:${cleanEnv.PATH ?? ""}`;
    }
    const claudeBin = `${homedir()}/.local/bin/claude`;

    const chunks: string[] = [];

    for await (const event of query({
      prompt: `Read and analyze this image file: ${tmpPath}\n\n${prompt}\n\nRespond with ONLY your analysis, no preamble.`,
      options: {
        model: "claude-sonnet-4-20250514",
        cwd: tmpdir(),
        permissionMode: "acceptEdits" as const,
        maxTurns: 3,
        maxBudgetUsd: 0.10,
        spawnClaudeCodeProcess: ({ args, signal }) => {
          return spawn(claudeBin, args, {
            env: cleanEnv,
            stdio: ["pipe", "pipe", "pipe"],
            signal,
          });
        },
      },
    })) {
      const ev = event as Record<string, unknown>;
      if (event.type === "assistant") {
        const msg = ev.message as Record<string, unknown> | undefined;
        const content = msg?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block) {
              chunks.push(block.text as string);
            }
          }
        }
      }
    }

    const durationMs = Date.now() - startMs;
    const text = chunks.join("\n").trim();
    log(`Vision: image analysis completed in ${durationMs}ms (${text.length} chars)`);

    return { text, model: "claude-sonnet-4-20250514", durationMs };
  } finally {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
  }
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

/**
 * Analyze a video using Gemini's native video understanding.
 * Free tier: 15 requests/minute, 1M tokens/day.
 *
 * Uses File API for uploads > 20MB, inline data for smaller videos.
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
