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
  /** System prompt for the Claude subprocess */
  systemPrompt?: string;
  /** Working directory for the subprocess (default: $HOME) */
  cwd?: string;
  /** Max conversation turns per message (default: 30) */
  maxTurns?: number;
  /** Max USD spend per deliver() call (default: 1.00) */
  maxBudgetUsd?: number;
  /** Permission mode: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" */
  permissionMode?: string;
  /** Whitelist of allowed tools */
  allowedTools?: string[];
}

export type BackendConfig = SessionBackendConfig | APIBackendConfig;
