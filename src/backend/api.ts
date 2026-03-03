/**
 * backend/api.ts — APIBackend: Claude Agent SDK subprocess bridge.
 *
 * Spawns a Claude Code subprocess via the Agent SDK's query() function.
 * Returns the assistant's response synchronously — no iTerm2 required.
 */

import type { Backend, APIBackendConfig } from "../types/backend.js";
import { log } from "../core/log.js";
import { homedir } from "os";

/** Session IDs for multi-turn conversations keyed by external session ID */
const claudeSessionMap = new Map<string, string>();

export class APIBackend implements Backend {
  readonly name: string;
  readonly type = "api" as const;
  readonly provider: APIBackendConfig["provider"];
  readonly model: string;
  private readonly config: APIBackendConfig;

  constructor(config: APIBackendConfig & { name?: string }) {
    this.name = config.name ?? `${config.provider}/${config.model}`;
    this.provider = config.provider;
    this.model = config.model;
    this.config = config;
  }

  async deliver(message: string, sessionId?: string): Promise<string | undefined> {
    if (this.provider !== "anthropic") {
      log(`APIBackend: provider '${this.provider}' not yet supported, only 'anthropic'`);
      return `Error: provider '${this.provider}' is not yet implemented. Use provider 'anthropic'.`;
    }

    try {
      // Dynamic import — avoid loading the SDK at module level for consumers that don't use API mode
      const { query } = await import("@anthropic-ai/claude-agent-sdk");

      const resumeId = sessionId ? claudeSessionMap.get(sessionId) : undefined;

      log(`APIBackend: delivering to ${this.model} (session=${sessionId ?? "none"}, resume=${resumeId ?? "new"})`);

      const chunks: string[] = [];
      let claudeSessionId: string | undefined;

      // Must unset CLAUDECODE env var to allow nested Claude subprocess
      const cleanEnv = { ...process.env };
      delete cleanEnv.CLAUDECODE;

      for await (const event of query({
        prompt: message,
        options: {
          model: this.config.model,
          cwd: this.config.cwd ?? homedir(),
          systemPrompt: this.config.systemPrompt,
          permissionMode: (this.config.permissionMode as "acceptEdits") ?? "acceptEdits",
          allowedTools: this.config.allowedTools,
          maxTurns: this.config.maxTurns ?? 30,
          maxBudgetUsd: this.config.maxBudgetUsd ?? 1.0,
          ...(resumeId ? { resume: resumeId } : {}),
          spawnClaudeCodeProcess: ({ args, signal }) => {
            const { spawn } = require("child_process") as typeof import("child_process");
            return spawn("claude", args, {
              env: cleanEnv,
              stdio: ["pipe", "pipe", "pipe"],
              signal,
            });
          },
        },
      })) {
        if (event.type === "system") {
          // Capture the Claude session ID for multi-turn resume
          const sysEvent = event as Record<string, unknown>;
          if (typeof sysEvent.session_id === "string") {
            claudeSessionId = sysEvent.session_id;
          }
        } else if (event.type === "assistant") {
          // Extract text content from assistant messages
          const msg = event as Record<string, unknown>;
          const message = msg.message as Record<string, unknown> | undefined;
          const content = message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block) {
                chunks.push(block.text as string);
              }
            }
          }
        }
      }

      // Store Claude session ID for future resume
      if (sessionId && claudeSessionId) {
        claudeSessionMap.set(sessionId, claudeSessionId);
      }

      const response = chunks.join("\n").trim();
      log(`APIBackend: got response (${response.length} chars, session=${claudeSessionId ?? "unknown"})`);

      return response || undefined;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`APIBackend: error — ${msg}`);
      return `Error from Claude subprocess: ${msg}`;
    }
  }
}
