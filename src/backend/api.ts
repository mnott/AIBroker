/**
 * backend/api.ts — APIBackend: direct HTTP API calls to AI providers.
 *
 * Stub for Phase 9. Will implement:
 * - Anthropic API (Claude)
 * - OpenAI API (ChatGPT)
 * - Ollama API (local models)
 */

import type { Backend, APIBackendConfig } from "../types/backend.js";
import { log } from "../core/log.js";

export class APIBackend implements Backend {
  readonly name: string;
  readonly type = "api" as const;
  readonly provider: APIBackendConfig["provider"];
  readonly model: string;

  constructor(config: APIBackendConfig & { name?: string }) {
    this.name = config.name ?? `${config.provider}/${config.model}`;
    this.provider = config.provider;
    this.model = config.model;
  }

  async deliver(message: string, _sessionId?: string): Promise<string | undefined> {
    log(`APIBackend: not yet implemented (provider=${this.provider}, model=${this.model})`);
    throw new Error(
      `APIBackend is not yet implemented. Use SessionBackend for now. ` +
      `(provider=${this.provider}, model=${this.model})`,
    );
  }
}
