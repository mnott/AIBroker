/**
 * daemon/image-gen/providers/cloudflare.ts — Cloudflare Workers AI image generation provider.
 *
 * Uses Cloudflare's AI REST API with the Flux schnell model.
 * Free tier: 10,000 neurons/day.
 *
 * Requires:
 *   CLOUDFLARE_AI_TOKEN — API token with AI:Run permission
 *   CLOUDFLARE_ACCOUNT_ID — Cloudflare account ID
 */

import { log } from "../../../core/log.js";
import type { GenerateImageOptions, GenerateImageResult, ImageProvider, ImageProviderConfig } from "../types.js";

const DEFAULT_MODEL = "@cf/black-forest-labs/flux-1-schnell";

export function createCloudflareProvider(config: ImageProviderConfig = { provider: "cloudflare" }): ImageProvider {
  return {
    name: "cloudflare",

    async generate(opts: GenerateImageOptions): Promise<GenerateImageResult> {
      const tokenEnv = config.apiTokenEnv ?? "CLOUDFLARE_AI_TOKEN";
      const token = config.apiToken ?? process.env[tokenEnv];
      if (!token) {
        throw new Error(`Cloudflare API error: ${tokenEnv} not set`);
      }

      const accountId = config.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID;
      if (!accountId) {
        throw new Error("Cloudflare API error: CLOUDFLARE_ACCOUNT_ID not set");
      }

      const model = opts.model ?? config.model ?? DEFAULT_MODEL;
      const startMs = Date.now();
      const endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;

      log(`Image gen: using cloudflare (${model})`);

      const body: Record<string, unknown> = {
        prompt: opts.prompt,
        num_steps: 4,  // Flux schnell optimal
      };
      if (opts.width) body.width = opts.width;
      if (opts.height) body.height = opts.height;

      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Cloudflare API error (${res.status}): ${errText}`);
      }

      // Cloudflare returns JSON with base64 image
      const data = await res.json() as {
        success: boolean;
        result?: { image: string };
        errors?: Array<{ message: string }>;
      };

      if (!data.success || !data.result?.image) {
        const errMsg = data.errors?.map((e) => e.message).join(", ") ?? "unknown error";
        throw new Error(`Cloudflare API error: ${errMsg}`);
      }

      const imageBuffer = Buffer.from(data.result.image, "base64");
      const durationMs = Date.now() - startMs;

      log(`Image gen: completed in ${durationMs}ms, 1 image(s), ${imageBuffer.length} bytes total`);

      return { images: [imageBuffer], model, durationMs };
    },
  };
}
