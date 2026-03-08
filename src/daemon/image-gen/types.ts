/**
 * daemon/image-gen/types.ts — Shared types for image generation providers.
 */

export interface GenerateImageOptions {
  prompt: string;
  model?: string;
  width?: number;
  height?: number;
  numOutputs?: number;
}

export interface GenerateImageResult {
  images: Buffer[];
  model: string;
  durationMs: number;
}

export interface ImageProvider {
  name: string;
  generate(opts: GenerateImageOptions): Promise<GenerateImageResult>;
}

export interface ImageProviderConfig {
  provider: string;       // "replicate" | "cloudflare" | "huggingface" | "pollinations" | "custom"
  model?: string;         // provider-specific model ID
  apiToken?: string;      // override env var
  apiTokenEnv?: string;   // env var name to read token from (default varies by provider)
  accountId?: string;     // Cloudflare account ID (cloudflare provider only)
  modulePath?: string;    // path to custom provider module (custom provider only)
  options?: Record<string, unknown>;  // arbitrary options passed to custom provider
}
