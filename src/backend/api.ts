/**
 * backend/api.ts — APIBackend: Claude Agent SDK subprocess bridge.
 *
 * Spawns a Claude Code subprocess via the Agent SDK's query() function.
 * Returns the assistant's response synchronously — no iTerm2 required.
 *
 * Supports multiple parallel sessions, each with its own conversation
 * context, working directory, and Claude session UUID for resume.
 *
 * Tracks live session status (thinking, tool_running, compacting, etc.)
 * so consumers can show meaningful status via /ss.
 */

import type { Backend, APIBackendConfig } from "../types/backend.js";
import { log } from "../core/log.js";
import { homedir } from "os";
import { spawn } from "child_process";

/** Live status of a session's current deliver() call */
export type SessionState =
  | "idle"
  | "thinking"
  | "tool_running"
  | "compacting"
  | "done"
  | "error";

/** Live status snapshot for a session */
export interface SessionStatus {
  state: SessionState;
  /** Current tool name (when state === "tool_running") */
  currentTool?: string;
  /** How long the current tool has been running (seconds) */
  toolElapsed?: number;
  /** Number of turns completed so far */
  turns: number;
  /** Accumulated cost in USD */
  costUsd: number;
  /** Result subtype from the last completed deliver() */
  lastResult?: string;
  /** Error messages from the last completed deliver() */
  lastErrors?: string[];
  /** Permission denials encountered */
  permissionDenials: number;
  /** Timestamp when deliver() started */
  startedAt?: number;
}

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

function defaultStatus(): SessionStatus {
  return { state: "idle", turns: 0, costUsd: 0, permissionDenials: 0 };
}

export class APIBackend implements Backend {
  readonly name: string;
  readonly type = "api" as const;
  readonly provider: APIBackendConfig["provider"];
  readonly model: string;
  private readonly config: APIBackendConfig;

  /** All active API sessions */
  private readonly sessions = new Map<string, APISession>();
  /** Live status per session */
  private readonly statuses = new Map<string, SessionStatus>();
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
    this.statuses.set(id, defaultStatus());
    this._activeSessionId = id;
    log(`APIBackend: created session ${id} "${name}" (cwd=${session.cwd})`);
    return session;
  }

  /** End a session and switch to another if it was active */
  endSession(id: string): boolean {
    if (!this.sessions.has(id)) return false;
    this.sessions.delete(id);
    this.statuses.delete(id);
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
      this.statuses.set(targetId, defaultStatus());
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

  /** Get live status for a session (or the active session) */
  getStatus(sessionId?: string): SessionStatus {
    const id = sessionId ?? this._activeSessionId;
    return this.statuses.get(id) ?? defaultStatus();
  }

  /** Get a formatted status string suitable for display */
  formatStatus(): string {
    const sessions = this.listSessions();
    const lines: string[] = [
      `*API Mode — ${this.model}*`,
      ``,
    ];

    for (const s of sessions) {
      const isActive = s.id === this._activeSessionId;
      const status = this.statuses.get(s.id) ?? defaultStatus();

      // Session header
      const marker = isActive ? "*" : " ";
      lines.push(`${marker}${s.name} (${s.cwd})`);

      // State line
      const stateDisplay = this.formatState(status);
      const ctx = s.claudeSessionId ? "has context" : "fresh";
      lines.push(`  ${stateDisplay} | ${ctx}`);

      // Stats line (only if there's been activity)
      if (status.turns > 0 || status.costUsd > 0) {
        const cost = status.costUsd > 0 ? ` | $${status.costUsd.toFixed(3)}` : "";
        lines.push(`  ${status.turns} turns${cost}`);
      }

      // Errors or denials
      if (status.lastErrors?.length) {
        lines.push(`  Error: ${status.lastErrors[0]}`);
      }
      if (status.permissionDenials > 0) {
        lines.push(`  ${status.permissionDenials} permission denial(s)`);
      }
    }

    return lines.join("\n");
  }

  private formatState(status: SessionStatus): string {
    switch (status.state) {
      case "idle":
        if (status.lastResult) {
          return status.lastResult === "success" ? "Idle (completed)" : `Idle (${status.lastResult})`;
        }
        return "Idle";
      case "thinking": {
        const elapsed = status.startedAt ? Math.round((Date.now() - status.startedAt) / 1000) : 0;
        return `Thinking... (${elapsed}s)`;
      }
      case "tool_running": {
        const tool = status.currentTool ?? "unknown";
        const secs = status.toolElapsed ? `${Math.round(status.toolElapsed)}s` : "";
        return `Running: ${tool} ${secs}`.trim();
      }
      case "compacting":
        return "Compacting context...";
      case "done":
        return status.lastResult === "success" ? "Done" : `Done (${status.lastResult})`;
      case "error":
        return "Error";
      default:
        return String(status.state);
    }
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

    // Initialize live status tracking
    const status: SessionStatus = {
      state: "thinking",
      turns: 0,
      costUsd: 0,
      permissionDenials: 0,
      startedAt: Date.now(),
    };
    if (targetId) this.statuses.set(targetId, status);

    try {
      // Dynamic import — avoid loading the SDK at module level for consumers that don't use API mode
      const { query } = await import("@anthropic-ai/claude-agent-sdk");

      log(`APIBackend: delivering to ${this.model} (session=${targetId ?? "none"}, resume=${resumeId ?? "new"}, cwd=${cwd})`);

      const chunks: string[] = [];
      let claudeSessionId: string | undefined;

      // Build clean env: unset CLAUDECODE to allow nested subprocess,
      // set IS_SANDBOX=1 to match the user's shell alias convention,
      // ensure PATH includes ~/.local/bin where Claude CLI lives.
      const cleanEnv = { ...process.env };
      delete cleanEnv.CLAUDECODE;
      cleanEnv.IS_SANDBOX = "1";
      if (!cleanEnv.PATH?.includes(".local/bin")) {
        cleanEnv.PATH = `${homedir()}/.local/bin:${cleanEnv.PATH ?? ""}`;
      }

      // Resolve Claude CLI binary path — shell aliases aren't available in spawn()
      const claudeBin = `${homedir()}/.local/bin/claude`;

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
            return spawn(claudeBin, args, {
              env: cleanEnv,
              stdio: ["pipe", "pipe", "pipe"],
              signal,
            });
          },
        },
      })) {
        // Track SDK events for live status
        const ev = event as Record<string, unknown>;

        if (event.type === "system") {
          if (typeof ev.session_id === "string") {
            claudeSessionId = ev.session_id;
          }
          if (ev.subtype === "status") {
            status.state = ev.status === "compacting" ? "compacting" : "thinking";
          }
          if (ev.subtype === "compact_boundary") {
            // Context was compacted — note it happened
            log(`APIBackend: context compacted (session=${targetId})`);
          }
        } else if (event.type === "assistant") {
          status.state = "thinking";
          status.currentTool = undefined;
          status.toolElapsed = undefined;
          const msg = ev.message as Record<string, unknown> | undefined;
          const content = msg?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block) {
                chunks.push(block.text as string);
              }
            }
          }
        } else if (event.type === "tool_progress") {
          status.state = "tool_running";
          status.currentTool = typeof ev.tool_name === "string" ? ev.tool_name : undefined;
          status.toolElapsed = typeof ev.elapsed_time_seconds === "number" ? ev.elapsed_time_seconds : undefined;
        } else if (event.type === "result") {
          const subtype = typeof ev.subtype === "string" ? ev.subtype : "unknown";
          status.state = "done";
          status.lastResult = subtype;
          status.currentTool = undefined;
          status.toolElapsed = undefined;
          if (typeof ev.num_turns === "number") status.turns = ev.num_turns;
          if (typeof ev.total_cost_usd === "number") status.costUsd = ev.total_cost_usd;
          if (Array.isArray(ev.permission_denials)) status.permissionDenials = ev.permission_denials.length;
          if (Array.isArray(ev.errors)) status.lastErrors = ev.errors as string[];
        }
      }

      // Store Claude session UUID for future resume
      if (session && claudeSessionId) {
        session.claudeSessionId = claudeSessionId;
      }

      // Finalize status
      status.state = "idle";
      status.lastResult = status.lastResult ?? "success";

      const response = chunks.join("\n").trim();
      log(`APIBackend: got response (${response.length} chars, session=${claudeSessionId ?? "unknown"}, turns=${status.turns}, cost=$${status.costUsd.toFixed(3)})`);

      return response || undefined;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`APIBackend: error — ${msg}`);
      status.state = "error";
      status.lastErrors = [msg];
      return `Error from Claude subprocess: ${msg}`;
    }
  }
}
