/**
 * daemon/image-gen/index.ts — Provider-pluggable image generation.
 *
 * Public interface: generateImage() — identical signature to the old image-gen.ts.
 * Callers only need to update their import path.
 *
 * Provider resolution order:
 *   1. ~/.aibroker/image-gen.json (explicit config)
 *   2. Env var detection: REPLICATE_API_TOKEN → CLOUDFLARE_AI_TOKEN → HF_API_TOKEN
 *   3. Fallback: Pollinations (no auth, always works)
 */

import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { log } from "../../core/log.js";
import type { GenerateImageOptions, GenerateImageResult, ImageProvider, ImageProviderConfig } from "./types.js";
import { createReplicateProvider } from "./providers/replicate.js";
import { createCloudflareProvider } from "./providers/cloudflare.js";
import { createHuggingFaceProvider } from "./providers/huggingface.js";
import { createPollinationsProvider } from "./providers/pollinations.js";

export type { GenerateImageOptions, GenerateImageResult, ImageProvider, ImageProviderConfig };

const CONFIG_PATH = join(homedir(), ".aibroker", "image-gen.json");

/**
 * Generate an image from a text prompt.
 *
 * Provider is resolved from ~/.aibroker/image-gen.json, then env vars,
 * then falls back to Pollinations (no auth needed).
 */
export async function generateImage(opts: GenerateImageOptions): Promise<GenerateImageResult> {
  const provider = getConfiguredProvider();
  return provider.generate(opts);
}

function getConfiguredProvider(): ImageProvider {
  // 1. Explicit config file
  const config = loadConfig();
  if (config) {
    return buildProvider(config);
  }

  // 2. Env var detection
  if (process.env.REPLICATE_API_TOKEN) {
    log("Image gen: detected REPLICATE_API_TOKEN, using replicate");
    return createReplicateProvider();
  }

  if (process.env.CLOUDFLARE_AI_TOKEN) {
    log("Image gen: detected CLOUDFLARE_AI_TOKEN, using cloudflare");
    return createCloudflareProvider();
  }

  if (process.env.HF_API_TOKEN) {
    log("Image gen: detected HF_API_TOKEN, using huggingface");
    return createHuggingFaceProvider();
  }

  // 3. Fallback: Pollinations (no auth needed)
  log("Image gen: no token detected, falling back to pollinations");
  return createPollinationsProvider();
}

function buildProvider(config: ImageProviderConfig): ImageProvider {
  switch (config.provider) {
    case "replicate":
      return createReplicateProvider(config);
    case "cloudflare":
      return createCloudflareProvider(config);
    case "huggingface":
      return createHuggingFaceProvider(config);
    case "pollinations":
      return createPollinationsProvider();
    default:
      log(`Image gen: unknown provider "${config.provider}", falling back to pollinations`);
      return createPollinationsProvider();
  }
}

function loadConfig(): ImageProviderConfig | null {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw) as ImageProviderConfig;
    if (typeof parsed.provider === "string") {
      log(`Image gen: loaded config from ${CONFIG_PATH} (provider: ${parsed.provider})`);
      return parsed;
    }
    log(`Image gen: config at ${CONFIG_PATH} missing "provider" field, ignoring`);
    return null;
  } catch {
    // File doesn't exist or is malformed — not an error, just use env/fallback
    return null;
  }
}
