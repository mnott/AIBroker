/**
 * daemon/image-gen.ts — Image generation via Replicate Flux schnell.
 *
 * Generates images from text prompts using the Replicate API.
 * Default model: black-forest-labs/flux-schnell (~$0.003/image, 2-4s).
 *
 * Requires REPLICATE_API_TOKEN in environment.
 */

import { log } from "../core/log.js";

const REPLICATE_API_URL = "https://api.replicate.com/v1/models";
const DEFAULT_MODEL = "black-forest-labs/flux-schnell";

interface GenerateImageOptions {
  prompt: string;
  model?: string;
  width?: number;
  height?: number;
  numOutputs?: number;
}

interface GenerateImageResult {
  images: Buffer[];
  model: string;
  durationMs: number;
}

/**
 * Generate an image from a text prompt via Replicate API.
 *
 * Returns raw image buffers (PNG/WebP depending on model).
 */
export async function generateImage(opts: GenerateImageOptions): Promise<GenerateImageResult> {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) {
    throw new Error("REPLICATE_API_TOKEN not set. Get one at https://replicate.com/account/api-tokens");
  }

  const model = opts.model ?? DEFAULT_MODEL;
  const startMs = Date.now();

  // Replicate's "create prediction" endpoint for official models
  const predictionUrl = `${REPLICATE_API_URL}/${model}/predictions`;

  const body = {
    input: {
      prompt: opts.prompt,
      num_outputs: opts.numOutputs ?? 1,
      ...(opts.width ? { width: opts.width } : {}),
      ...(opts.height ? { height: opts.height } : {}),
    },
  };

  log(`Image gen: requesting "${opts.prompt.slice(0, 80)}" via ${model}`);

  // Start prediction
  const startRes = await fetch(predictionUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "wait",  // Synchronous mode — waits for completion
    },
    body: JSON.stringify(body),
  });

  if (!startRes.ok) {
    const errText = await startRes.text();
    throw new Error(`Replicate API error (${startRes.status}): ${errText}`);
  }

  const prediction = await startRes.json() as {
    status: string;
    output?: string[];
    error?: string;
    urls?: { get: string };
  };

  // If "Prefer: wait" didn't complete, poll
  if (prediction.status !== "succeeded" && prediction.status !== "failed") {
    const polled = await pollPrediction(prediction.urls?.get ?? "", token);
    if (polled.status === "failed") {
      throw new Error(`Image generation failed: ${polled.error ?? "unknown error"}`);
    }
    prediction.output = polled.output;
    prediction.status = polled.status;
  }

  if (prediction.status === "failed") {
    throw new Error(`Image generation failed: ${prediction.error ?? "unknown error"}`);
  }

  if (!prediction.output || prediction.output.length === 0) {
    throw new Error("Image generation returned no output");
  }

  // Download image URLs to buffers
  const images: Buffer[] = [];
  for (const url of prediction.output) {
    const imgRes = await fetch(url);
    if (!imgRes.ok) {
      throw new Error(`Failed to download image: ${imgRes.status}`);
    }
    const arrayBuf = await imgRes.arrayBuffer();
    images.push(Buffer.from(arrayBuf));
  }

  const durationMs = Date.now() - startMs;
  log(`Image gen: completed in ${durationMs}ms, ${images.length} image(s), ${images.reduce((s, b) => s + b.length, 0)} bytes total`);

  return { images, model, durationMs };
}

async function pollPrediction(
  url: string,
  token: string,
  maxWaitMs = 60_000,
): Promise<{ status: string; output?: string[]; error?: string }> {
  const startMs = Date.now();
  const pollIntervalMs = 1000;

  while (Date.now() - startMs < maxWaitMs) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      throw new Error(`Replicate poll error (${res.status}): ${await res.text()}`);
    }

    const data = await res.json() as { status: string; output?: string[]; error?: string };
    if (data.status === "succeeded" || data.status === "failed") {
      return data;
    }
  }

  throw new Error(`Image generation timed out after ${maxWaitMs}ms`);
}
