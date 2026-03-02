/**
 * Backend interface — AI model abstraction.
 *
 * Two flavors:
 * - SessionBackend: delivers via typeIntoSession (iTerm2 CLI sessions)
 * - APIBackend: delivers via direct HTTP API calls (future)
 */

export interface Backend {
  readonly name: string;
  readonly type: "session" | "api";
  deliver(message: string, sessionId?: string): Promise<string | undefined>;
}

export interface SessionBackendConfig {
  type: "session";
  command: string;
}

export interface APIBackendConfig {
  type: "api";
  provider: "anthropic" | "openai" | "ollama";
  model: string;
  baseUrl?: string;
  apiKey?: string;
}

export type BackendConfig = SessionBackendConfig | APIBackendConfig;
