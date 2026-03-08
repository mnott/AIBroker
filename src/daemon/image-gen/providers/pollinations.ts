/**
 * daemon/image-gen/providers/pollinations.ts — Pollinations.ai image generation provider.
 *
 * Free, no authentication required.
 * Endpoint: https://image.pollinations.ai/prompt/{encoded_prompt}
 *
 * Returns image bytes directly — no API key needed.
 */

import { log } from "../../../core/log.js";
import type { GenerateImageOptions, GenerateImageResult, ImageProvider } from "../types.js";

const POLLINATIONS_BASE = "https://image.pollinations.ai/prompt";
const DEFAULT_MODEL = "flux";

export function createPollinationsProvider(): ImageProvider {
  return {
    name: "pollinations",

    async generate(opts: GenerateImageOptions): Promise<GenerateImageResult> {
      const model = opts.model ?? DEFAULT_MODEL;
      const startMs = Date.now();

      const params = new URLSearchParams({
        nologo: "true",
        model,
        ...(opts.width ? { width: String(opts.width) } : {}),
        ...(opts.height ? { height: String(opts.height) } : {}),
      });

      const encodedPrompt = encodeURIComponent(opts.prompt);
      const endpoint = `${POLLINATIONS_BASE}/${encodedPrompt}?${params.toString()}`;

      log(`Image gen: using pollinations (${model})`);

      const res = await fetch(endpoint);

      if (!res.ok) {
        throw new Error(`Pollinations API error (${res.status}): ${await res.text()}`);
      }

      const arrayBuf = await res.arrayBuffer();
      const imageBuffer = Buffer.from(arrayBuf);
      const durationMs = Date.now() - startMs;

      log(`Image gen: completed in ${durationMs}ms, 1 image(s), ${imageBuffer.length} bytes total`);

      return { images: [imageBuffer], model, durationMs };
    },
  };
}
