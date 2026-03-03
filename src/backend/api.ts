/**
 * backend/api.ts — APIBackend: Claude Agent SDK subprocess bridge.
 *
 * Spawns a Claude Code subprocess via the Agent SDK's query() function.
 * Returns the assistant's response synchronously — no iTerm2 required.
 *
 * Supports multiple parallel sessions, each with its own conversation
 * context, working directory, and Claude session UUID for resume.
 */

import type { Backend, APIBackendConfig } from "../types/backend.js";
import { log } from "../core/log.js";
import { homedir } from "os";
import { spawn } from "child_process";

/** Metadata for a single API session */
export interface APISession {
  /** External session ID (e.g. "api-1") */
  id: string;
  /** Human-readable name */
  name: string;
  /** Working directory for this session */
  cwd: string;
  /** Claude Agent SDK session UUID for resume (set after first message) */
  claudeSessionId?: string;
  /** Timestamp of last activity */
  lastActive: number;
}

export class APIBackend implements Backend {
  readonly name: string;
  readonly type = "api" as const;
  readonly provider: APIBackendConfig["provider"];
  readonly model: string;
  private readonly config: APIBackendConfig;

  /** All active API sessions */
  private readonly sessions = new Map<string, APISession>();
  /** Currently active session ID */
  private _activeSessionId: string = "";
  /** Auto-increment counter for session IDs */
  private nextSessionNum = 1;

  constructor(config: APIBackendConfig & { name?: string }) {
    this.name = config.name ?? `${config.provider}/${config.model}`;
    this.provider = config.provider;
    this.model = config.model;
    this.config = config;

    // Create default session
    this.createSession("Default", config.cwd ?? homedir());
  }

  /** Get the active session ID */
  get activeSessionId(): string {
    return this._activeSessionId;
  }

  /** Switch the active session */
  set activeSessionId(id: string) {
    if (this.sessions.has(id)) {
      this._activeSessionId = id;
      log(`APIBackend: switched to session ${id} (${this.sessions.get(id)!.name})`);
    }
  }

  /** Create a new session and make it active */
  createSession(name: string, cwd?: string): APISession {
    const id = `api-${this.nextSessionNum++}`;
    const session: APISession = {
      id,
      name,
      cwd: cwd ?? this.config.cwd ?? homedir(),
      lastActive: Date.now(),
    };
    this.sessions.set(id, session);
    this._activeSessionId = id;
    log(`APIBackend: created session ${id} "${name}" (cwd=${session.cwd})`);
    return session;
  }

  /** End a session and switch to another if it was active */
  endSession(id: string): boolean {
    if (!this.sessions.has(id)) return false;
    this.sessions.delete(id);
    log(`APIBackend: ended session ${id}`);

    // Switch to most recent remaining session
    if (this._activeSessionId === id) {
      const remaining = [...this.sessions.values()].sort((a, b) => b.lastActive - a.lastActive);
      this._activeSessionId = remaining.length > 0 ? remaining[0].id : "";
    }
    return true;
  }

  /** Clear the active session's conversation (starts fresh on next message) */
  clearSession(id?: string): void {
    const targetId = id ?? this._activeSessionId;
    const session = this.sessions.get(targetId);
    if (session) {
      session.claudeSessionId = undefined;
      log(`APIBackend: cleared conversation for session ${targetId}`);
    }
  }

  /** List all sessions ordered by number */
  listSessions(): APISession[] {
    return [...this.sessions.values()].sort((a, b) => {
      const numA = parseInt(a.id.replace("api-", ""), 10);
      const numB = parseInt(b.id.replace("api-", ""), 10);
      return numA - numB;
    });
  }

  /** Get session by list index (1-based, matching /s display) */
  getSessionByIndex(index: number): APISession | undefined {
    const list = this.listSessions();
    return list[index - 1];
  }

  async deliver(message: string, sessionId?: string): Promise<string | undefined> {
    if (this.provider !== "anthropic") {
      log(`APIBackend: provider '${this.provider}' not yet supported, only 'anthropic'`);
      return `Error: provider '${this.provider}' is not yet implemented. Use provider 'anthropic'.`;
    }

    // Resolve session — use explicit ID, fall back to active
    const targetId = sessionId ?? this._activeSessionId;
    const session = targetId ? this.sessions.get(targetId) : undefined;
    const resumeId = session?.claudeSessionId;
    const cwd = session?.cwd ?? this.config.cwd ?? homedir();

    if (session) session.lastActive = Date.now();

    try {
      // Dynamic import — avoid loading the SDK at module level for consumers that don't use API mode
      const { query } = await import("@anthropic-ai/claude-agent-sdk");

      log(`APIBackend: delivering to ${this.model} (session=${targetId ?? "none"}, resume=${resumeId ?? "new"}, cwd=${cwd})`);

      const chunks: string[] = [];
      let claudeSessionId: string | undefined;

      // Must unset CLAUDECODE env var to allow nested Claude subprocess
      const cleanEnv = { ...process.env };
      delete cleanEnv.CLAUDECODE;

      for await (const event of query({
        prompt: message,
        options: {
          model: this.config.model,
          cwd,
          systemPrompt: this.config.systemPrompt,
          permissionMode: (this.config.permissionMode as "acceptEdits") ?? "acceptEdits",
          allowedTools: this.config.allowedTools,
          maxTurns: this.config.maxTurns ?? 30,
          maxBudgetUsd: this.config.maxBudgetUsd ?? 1.0,
          ...(resumeId ? { resume: resumeId } : {}),
          spawnClaudeCodeProcess: ({ args, signal }) => {
            return spawn("claude", args, {
              env: cleanEnv,
              stdio: ["pipe", "pipe", "pipe"],
              signal,
            });
          },
        },
      })) {
        if (event.type === "system") {
          const sysEvent = event as Record<string, unknown>;
          if (typeof sysEvent.session_id === "string") {
            claudeSessionId = sysEvent.session_id;
          }
        } else if (event.type === "assistant") {
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

      // Store Claude session UUID for future resume
      if (session && claudeSessionId) {
        session.claudeSessionId = claudeSessionId;
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
