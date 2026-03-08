/**
 * daemon/image-gen/providers/replicate.ts — Replicate image generation provider.
 *
 * Uses the Replicate Flux schnell model by default.
 * Requires REPLICATE_API_TOKEN env var (or apiToken in config).
 */

import { log } from "../../../core/log.js";
import type { GenerateImageOptions, GenerateImageResult, ImageProvider, ImageProviderConfig, RefineImageOptions } from "../types.js";

const REPLICATE_API_URL = "https://api.replicate.com/v1/models";
const DEFAULT_MODEL = "black-forest-labs/flux-schnell";

export function createReplicateProvider(config: ImageProviderConfig = { provider: "replicate" }): ImageProvider {
  return {
    name: "replicate",

    async generate(opts: GenerateImageOptions): Promise<GenerateImageResult> {
      const tokenEnv = config.apiTokenEnv ?? "REPLICATE_API_TOKEN";
      const token = config.apiToken ?? process.env[tokenEnv];
      if (!token) {
        throw new Error(`Replicate API error: ${tokenEnv} not set. Get one at https://replicate.com/account/api-tokens`);
      }

      const model = opts.model ?? config.model ?? DEFAULT_MODEL;
      const startMs = Date.now();
      const predictionUrl = `${REPLICATE_API_URL}/${model}/predictions`;

      const body = {
        input: {
          prompt: opts.prompt,
          num_outputs: opts.numOutputs ?? 1,
          ...(opts.width ? { width: opts.width } : {}),
          ...(opts.height ? { height: opts.height } : {}),
        },
      };

      log(`Image gen: using replicate (${model})`);

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
          throw new Error(`Replicate API error: image generation failed — ${polled.error ?? "unknown error"}`);
        }
        prediction.output = polled.output;
        prediction.status = polled.status;
      }

      if (prediction.status === "failed") {
        throw new Error(`Replicate API error: image generation failed — ${prediction.error ?? "unknown error"}`);
      }

      if (!prediction.output || prediction.output.length === 0) {
        throw new Error("Replicate API error: generation returned no output");
      }

      // Download image URLs to buffers
      const images: Buffer[] = [];
      for (const url of prediction.output) {
        const imgRes = await fetch(url);
        if (!imgRes.ok) {
          throw new Error(`Replicate API error: failed to download image (${imgRes.status})`);
        }
        const arrayBuf = await imgRes.arrayBuffer();
        images.push(Buffer.from(arrayBuf));
      }

      const durationMs = Date.now() - startMs;
      log(`Image gen: completed in ${durationMs}ms, ${images.length} image(s), ${images.reduce((s, b) => s + b.length, 0)} bytes total`);

      return { images, model, durationMs };
    },

    async refine(opts: RefineImageOptions): Promise<GenerateImageResult> {
      const tokenEnv = config.apiTokenEnv ?? "REPLICATE_API_TOKEN";
      const token = config.apiToken ?? process.env[tokenEnv];
      if (!token) {
        throw new Error(`Replicate API error: ${tokenEnv} not set. Get one at https://replicate.com/account/api-tokens`);
      }

      // flux-dev supports image input; flux-schnell does not
      const model = "black-forest-labs/flux-dev";
      const predictionUrl = `${REPLICATE_API_URL}/${model}/predictions`;
      const startMs = Date.now();
      const strength = opts.strength ?? 0.7;

      // Encode source image as base64 data URI
      const base64Image = opts.sourceImage.toString("base64");
      const dataUri = `data:${opts.sourceMime};base64,${base64Image}`;

      const body = {
        input: {
          prompt: opts.prompt,
          image: dataUri,
          prompt_strength: strength,
          num_outputs: 1,
        },
      };

      log(`Image refine: using replicate (${model}), strength=${strength}`);

      const startRes = await fetch(predictionUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Prefer: "wait",
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

      if (prediction.status !== "succeeded" && prediction.status !== "failed") {
        const polled = await pollPrediction(prediction.urls?.get ?? "", token);
        if (polled.status === "failed") {
          throw new Error(`Replicate API error: image refinement failed — ${polled.error ?? "unknown error"}`);
        }
        prediction.output = polled.output;
        prediction.status = polled.status;
      }

      if (prediction.status === "failed") {
        throw new Error(`Replicate API error: image refinement failed — ${prediction.error ?? "unknown error"}`);
      }

      if (!prediction.output || prediction.output.length === 0) {
        throw new Error("Replicate API error: refinement returned no output");
      }

      const images: Buffer[] = [];
      for (const url of prediction.output) {
        const imgRes = await fetch(url);
        if (!imgRes.ok) {
          throw new Error(`Replicate API error: failed to download refined image (${imgRes.status})`);
        }
        const arrayBuf = await imgRes.arrayBuffer();
        images.push(Buffer.from(arrayBuf));
      }

      const durationMs = Date.now() - startMs;
      log(`Image refine: completed in ${durationMs}ms, ${images.length} image(s)`);

      return { images, model, durationMs };
    },
  };
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
      throw new Error(`Replicate API error: poll failed (${res.status}) — ${await res.text()}`);
    }

    const data = await res.json() as { status: string; output?: string[]; error?: string };
    if (data.status === "succeeded" || data.status === "failed") {
      return data;
    }
  }

  throw new Error(`Replicate API error: timed out after ${maxWaitMs}ms`);
}
