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

  // Optional lifecycle and session management (non-breaking additions)
  health?(): Promise<BackendHealth>;
  listSessions?(): BackendSession[];
  createSession?(name: string, cwd?: string): BackendSession;
  removeSession?(sessionId: string): Promise<void>;
  sessionStatus?(sessionId: string): BackendSessionStatus | undefined;
}

export interface BackendHealth {
  status: "ok" | "degraded" | "down";
  activeSessions: number;
  detail?: string;
}

export interface BackendSession {
  id: string;
  name: string;
  cwd?: string;
  /** Timestamp when the session was created (milliseconds since epoch) */
  createdAt?: number;
}

export type BackendSessionStatus = "idle" | "busy" | "error" | "terminated";

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
  /** Skip auto-creating the initial "Default" session (for HybridSessionManager) */
  skipDefaultSession?: boolean;
}

export interface OllamaBackendConfig {
  type: "ollama";
  model: string;
  baseUrl?: string;
}

export interface CustomBackendConfig {
  type: "custom";
  modulePath: string;
  options: Record<string, unknown>;
}

export type BackendConfig =
  | SessionBackendConfig
  | APIBackendConfig
  | OllamaBackendConfig
  | CustomBackendConfig;
