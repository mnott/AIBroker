/**
 * ipc/client.ts — MCP-side IPC client.
 *
 * WatcherClient connects to the watcher's Unix Domain Socket.
 * Socket path is injected so each consumer uses its own socket.
 */

import { connect, Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename } from "node:path";

import { execFileSync } from "node:child_process";
import { readlinkSync } from "node:fs";

import type { IpcRequest, IpcResponse } from "../types/ipc.js";

/**
 * The terminal this process is attached to, or undefined when there is none.
 *
 * Read from the file descriptor rather than by running `tty`: this is on the
 * path of every call, and spawning a process to learn something the kernel
 * already knows would be a cost paid thousands of times a day. Any of the three
 * standard descriptors will do — a caller with a redirected stdin usually still
 * has a terminal on stdout or stderr.
 */
let _callerTty: string | null | undefined;

function callerTty(): string | undefined {
  if (_callerTty !== undefined) return _callerTty ?? undefined;
  _callerTty = resolveTty();
  return _callerTty ?? undefined;
}

function resolveTty(): string | null {
  // The direct case: a CLI run straight in the pane owns the terminal.
  for (const fd of [0, 1, 2]) {
    try {
      const path = readlinkSync(`/dev/fd/${fd}`);
      if (path.startsWith("/dev/tty")) return path;
    } catch {
      /* not a terminal, or no such descriptor — try the next */
    }
  }

  /*
   * The indirect case, and the one that matters: an MCP server is spawned by
   * the session with pipes for stdio, so it owns no terminal while sitting
   * squarely inside the session whose identity is in question. Its ancestors
   * do own one — walk up until a process reports a terminal, and that is the
   * pane the whole tree lives in.
   *
   * Cached for the life of the process: a session does not move between panes,
   * and this is otherwise on the path of every call.
   */
  try {
    let pid = process.pid;
    for (let hop = 0; hop < 8; hop++) {
      const line = execFileSync("ps", ["-o", "ppid=,tty=", "-p", String(pid)], {
        encoding: "utf8",
        timeout: 5_000,
      }).trim();
      if (!line) return null;
      const [ppid, tty] = line.split(/\s+/);
      if (tty && tty !== "??" && tty !== "?") return tty.startsWith("/dev/") ? tty : `/dev/${tty}`;
      if (!ppid || ppid === "0" || ppid === "1") return null;
      pid = Number(ppid);
      if (!Number.isFinite(pid)) return null;
    }
  } catch {
    /* no ps, no permission, no answer — identity falls back to the claim */
  }
  return null;
}

export class WatcherClient {
  private readonly sessionId: string;
  private readonly socketPath: string;

  constructor(socketPath: string) {
    this.sessionId = process.env.TERM_SESSION_ID ?? "unknown-session";
    this.socketPath = socketPath;
  }

  get session(): string {
    return this.sessionId;
  }

  private get defaultName(): string {
    const cwd = process.cwd();
    const home = homedir();
    if (cwd === home) return "Home";
    return basename(cwd);
  }

  // ── Public API ──

  async register(name?: string): Promise<Record<string, unknown>> {
    const params: Record<string, unknown> = { name: name ?? this.defaultName };
    const itermSessionId = process.env.ITERM_SESSION_ID;
    if (itermSessionId) params.itermSessionId = itermSessionId;
    if (process.env.TMUX_PANE) params.tmuxPane = process.env.TMUX_PANE;
    return this.call("register", params);
  }

  async rename(name: string): Promise<Record<string, unknown>> {
    return this.call("rename", { name });
  }

  async status(): Promise<Record<string, unknown>> {
    return this.call("status", {});
  }

  async send(message: string, recipient?: string, channel?: string): Promise<Record<string, unknown>> {
    const params: Record<string, unknown> = { message };
    if (recipient !== undefined) params.recipient = recipient;
    if (channel !== undefined) params.channel = channel;
    return this.call("send", params);
  }

  async receive(from?: string): Promise<Record<string, unknown>> {
    const params: Record<string, unknown> = {};
    if (from !== undefined) params.from = from;
    return this.call("receive", params);
  }

  async contacts(search?: string, limit?: number): Promise<Record<string, unknown>> {
    const params: Record<string, unknown> = {};
    if (search !== undefined) params.search = search;
    if (limit !== undefined) params.limit = limit;
    return this.call("contacts", params);
  }

  async chats(search?: string, limit?: number): Promise<Record<string, unknown>> {
    const params: Record<string, unknown> = {};
    if (search !== undefined) params.search = search;
    if (limit !== undefined) params.limit = limit;
    return this.call("chats", params);
  }

  async wait(timeoutMs: number): Promise<Record<string, unknown>> {
    return this.call("wait", { timeoutMs });
  }

  async login(): Promise<Record<string, unknown>> {
    return this.call("login", {});
  }

  async history(params: { jid?: string; chatId?: string; count?: number }): Promise<Record<string, unknown>> {
    return this.call("history", params as Record<string, unknown>);
  }

  async tts(params: { text: string; voice?: string; jid?: string; recipient?: string; channel?: string }): Promise<Record<string, unknown>> {
    return this.call("tts", params as Record<string, unknown>);
  }

  async voiceConfig(action: "get" | "set", updates?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.call("voice_config", { action, ...updates });
  }

  async sendFile(filePath: string, recipient?: string, caption?: string, prettify?: boolean): Promise<Record<string, unknown>> {
    const params: Record<string, unknown> = { filePath };
    if (recipient !== undefined) params.recipient = recipient;
    if (caption !== undefined) params.caption = caption;
    if (prettify !== undefined) params.prettify = prettify;
    return this.call("send_file", params);
  }

  async speak(text: string, voice?: string): Promise<Record<string, unknown>> {
    const params: Record<string, unknown> = { text };
    if (voice !== undefined) params.voice = voice;
    return this.call("speak", params);
  }

  async discover(): Promise<Record<string, unknown>> {
    return this.call("discover", {});
  }

  async sessions(): Promise<Record<string, unknown>> {
    return this.call("sessions", {});
  }

  async switchSession(target: string): Promise<Record<string, unknown>> {
    return this.call("switch", { target });
  }

  async endSession(target: string): Promise<Record<string, unknown>> {
    return this.call("end_session", { target });
  }

  async command(text: string): Promise<Record<string, unknown>> {
    return this.call("command", { text });
  }

  async dictate(maxDuration?: number): Promise<Record<string, unknown>> {
    const params: Record<string, unknown> = {};
    if (maxDuration !== undefined) params.maxDuration = maxDuration;
    return this.call("dictate", params);
  }

  async restart(): Promise<Record<string, unknown>> {
    return this.call("restart", {});
  }

  async broadcastStatus(status: string): Promise<Record<string, unknown>> {
    return this.call("broadcast_status", { status });
  }

  // ── Generic call (for daemon CLI and adapter registration) ──

  async call_raw(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.call(method, params);
  }

  // ── Internal transport ──

  private call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      let socket: Socket | null = null;
      let done = false;
      let buffer = "";
      let timer: ReturnType<typeof setTimeout> | null = null;

      function finish(err: Error | null, value?: Record<string, unknown>): void {
        if (done) return;
        done = true;
        if (timer !== null) { clearTimeout(timer); timer = null; }
        try { socket?.destroy(); } catch { /* ignore */ }
        if (err) reject(err); else resolve(value!);
      }

      socket = connect(this.socketPath, () => {
        const request: IpcRequest = {
          id: randomUUID(),
          sessionId: this.sessionId,
          method,
          params,
        };
        const itermId = process.env.ITERM_SESSION_ID;
        if (itermId) request.itermSessionId = itermId;
        if (process.env.TMUX_PANE) request.tmuxPane = process.env.TMUX_PANE;
        const tty = callerTty();
        if (tty) request.callerTty = tty;
        socket!.write(JSON.stringify(request) + "\n");
      });

      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const nl = buffer.indexOf("\n");
        if (nl === -1) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);

        let response: IpcResponse;
        try {
          response = JSON.parse(line) as IpcResponse;
        } catch {
          finish(new Error(`IPC parse error: ${line}`));
          return;
        }

        if (!response.ok) {
          finish(new Error(response.error ?? "IPC call failed"));
        } else {
          finish(null, response.result ?? {});
        }
      });

      socket.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT" || err.code === "ECONNREFUSED") {
          finish(new Error("Watcher not running. Start it with the appropriate watch command."));
        } else {
          finish(err);
        }
      });

      socket.on("end", () => {
        if (!done) finish(new Error("IPC connection closed before response"));
      });

      timer = setTimeout(() => finish(new Error("IPC call timed out")), 310_000);
    });
  }
}
