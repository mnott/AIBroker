/**
 * daemon/image-gen/providers/huggingface.ts — Hugging Face Inference API image generation provider.
 *
 * Uses the HF Inference API to run image generation models.
 * Default model: black-forest-labs/FLUX.1-schnell
 * Free tier: rate-limited.
 *
 * Requires HF_API_TOKEN env var (or apiToken in config).
 */

import { log } from "../../../core/log.js";
import type { GenerateImageOptions, GenerateImageResult, ImageProvider, ImageProviderConfig } from "../types.js";

const HF_API_BASE = "https://api-inference.huggingface.co/models";
const DEFAULT_MODEL = "black-forest-labs/FLUX.1-schnell";

export function createHuggingFaceProvider(config: ImageProviderConfig = { provider: "huggingface" }): ImageProvider {
  return {
    name: "huggingface",

    async generate(opts: GenerateImageOptions): Promise<GenerateImageResult> {
      const tokenEnv = config.apiTokenEnv ?? "HF_API_TOKEN";
      const token = config.apiToken ?? process.env[tokenEnv];
      if (!token) {
        throw new Error(`Hugging Face API error: ${tokenEnv} not set. Get one at https://huggingface.co/settings/tokens`);
      }

      const model = opts.model ?? config.model ?? DEFAULT_MODEL;
      const startMs = Date.now();
      const endpoint = `${HF_API_BASE}/${model}`;

      log(`Image gen: using huggingface (${model})`);

      const body: Record<string, unknown> = {
        inputs: opts.prompt,
      };

      // HF accepts parameters for image dimensions
      if (opts.width || opts.height) {
        body.parameters = {
          ...(opts.width ? { width: opts.width } : {}),
          ...(opts.height ? { height: opts.height } : {}),
        };
      }

      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Accept": "image/*",
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Hugging Face API error (${res.status}): ${errText}`);
      }

      // HF returns image bytes directly in the response body
      const arrayBuf = await res.arrayBuffer();
      const imageBuffer = Buffer.from(arrayBuf);
      const durationMs = Date.now() - startMs;

      log(`Image gen: completed in ${durationMs}ms, 1 image(s), ${imageBuffer.length} bytes total`);

      return { images: [imageBuffer], model, durationMs };
    },
  };
}
