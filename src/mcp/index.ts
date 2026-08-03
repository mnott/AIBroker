#!/usr/bin/env node
/**
 * mcp/index.ts — AIBroker unified MCP server.
 *
 * Single MCP entry point replacing individual Whazaa and Telex MCP servers.
 * Connects to the AIBroker hub daemon at /tmp/aibroker.sock and forwards
 * all tool calls through the hub to the appropriate adapter.
 *
 * Tool groups:
 *   - aibroker_*  (17) — hub-level: status, sessions, TTS, dictation, image gen, session orchestration
 *   - whatsapp_*  (11) — proxied to whazaa adapter via adapter_call
 *   - telegram_*  (11) — proxied to telex adapter via adapter_call
 *   - pailot_*     (4) — direct hub calls for PAILot mobile app
 *
 * Usage in ~/.claude.json:
 *   "aibroker": {
 *     "type": "stdio",
 *     "command": "node",
 *     "args": ["/Users/i052341/dev/ai/AIBroker/dist/mcp/index.js"]
 *   }
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execSync } from "node:child_process";
import { WatcherClient } from "../ipc/client.js";

const DAEMON_SOCKET = "/tmp/aibroker.sock";

const hub = new WatcherClient(DAEMON_SOCKET);

// ── Session Identity ──
// Detect which iTerm session this MCP process belongs to.
// MCP processes are children of Claude Code, which runs inside an iTerm session.
// We find our TTY, then ask iTerm which session owns that TTY.
// This is resolved once at startup and cached for all subsequent tool calls.

let _resolvedSessionId: string | undefined;

function detectSessionId(): string | undefined {
  // 1. Try ITERM_SESSION_ID from env (works if shell exports it)
  const envId = process.env.ITERM_SESSION_ID?.split(":")[1];
  if (envId) return envId;

  // 2. Walk process tree to find the TTY of our ancestor shell
  try {
    // Get the TTY of our parent's parent (claude → zsh → tty)
    let pid = process.ppid;
    let tty = "";
    for (let i = 0; i < 5 && pid > 1; i++) {
      const info = execSync(`ps -o tty=,ppid= -p ${pid} 2>/dev/null`, { encoding: "utf-8" }).trim();
      const parts = info.split(/\s+/);
      if (parts[0] && parts[0] !== "??" && parts[0] !== "-") {
        tty = `/dev/${parts[0]}`;
        break;
      }
      pid = parseInt(parts[1] ?? "1", 10);
    }
    if (!tty) return undefined;

    // 3. Ask iTerm which session owns this TTY
    // Use multiple -e flags since osascript doesn't handle \n in single -e strings
    const result = execSync(
      `osascript` +
      ` -e 'tell application "iTerm2"'` +
      ` -e '  repeat with w in windows'` +
      ` -e '    repeat with t in tabs of w'` +
      ` -e '      repeat with s in sessions of t'` +
      ` -e '        if tty of s is "${tty}" then'` +
      ` -e '          return id of s'` +
      ` -e '        end if'` +
      ` -e '      end repeat'` +
      ` -e '    end repeat'` +
      ` -e '  end repeat'` +
      ` -e '  return ""'` +
      ` -e 'end tell'`,
      { encoding: "utf-8", timeout: 3000 },
    ).trim();
    return result || undefined;
  } catch {
    return undefined;
  }
}

// Resolve session identity:
// 0. TMUX_PANE (when inside tmux) — the pane id IS the daemon's session id for a
//    tmux session, and is correct per pane (ITERM_SESSION_ID would be the stale
//    id of the iTerm tab that birthed the tmux server — a different session).
// 1. ITERM_SESSION_ID env var (set by iTerm per tab)
// 2. AIBP registration with hub (hub resolves identity)
// 3. TTY detection (legacy — fragile but works on macOS)
_resolvedSessionId = process.env.TMUX_PANE ?? process.env.ITERM_SESSION_ID?.split(":")[1] ?? detectSessionId();

async function registerWithAibp(): Promise<void> {
  try {
    const pluginId = _resolvedSessionId ?? `mcp-${process.pid}`;
    const sessionEnvId = process.env.TMUX_PANE ?? process.env.ITERM_SESSION_ID?.split(":")[1] ?? _resolvedSessionId;
    const result = await hub.call_raw("aibp_register", {
      pluginId,
      sessionEnvId,
    });
    if (result.resolvedSession) {
      const resolved = (result.resolvedSession as string).replace("session:", "");
      if (resolved) {
        _resolvedSessionId = resolved;
      }
    }
  } catch {
    // Hub may not support AIBP yet — fall back to TTY detection silently
  }
}

// Fire and forget — don't block MCP startup
void registerWithAibp();

function getSessionId(): string | undefined {
  // Inside tmux, the pane id is the authoritative per-session identity (it equals
  // the daemon's snapshot id for tmux sessions). It must win over any AIBP/iTerm
  // value, which would be the stale id of the tab that started the tmux server.
  if (process.env.TMUX_PANE) return process.env.TMUX_PANE;
  // Prefer AIBP-resolved session, fall back to iTerm env var
  if (_resolvedSessionId) return _resolvedSessionId;
  const envId = process.env.ITERM_SESSION_ID?.split(":")[1];
  if (envId) return envId;
  return undefined;
}

function err(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return { content: [{ type: "text" as const, text: `Error: ${msg}` }], isError: true as const };
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

async function adapterCall(adapter: string, method: string, params: Record<string, unknown> = {}) {
  return hub.call_raw("adapter_call", { adapter, method, params });
}

// ── Server ──

const server = new McpServer(
  { name: "aibroker", version: "0.7.0" },
  {
    instructions: [
      "## AIBroker — Unified Message Bridge for Claude Code",
      "",
      "### CRITICAL ROUTING RULE (NEVER VIOLATE)",
      "",
      "Messages WITHOUT a prefix (e.g. [Whazaa], [PAILot], [Telex]) are typed at the TERMINAL.",
      "Terminal messages get TERMINAL-ONLY responses. NEVER call any send/tts tool for them.",
      "Only call send/tts tools when the incoming message HAS the matching prefix.",
      "This is per-message — each message is routed independently based on its prefix.",
      "",
      "### VOICE RULE (MANDATORY — DO NOT USE pailot_send FOR VOICE MESSAGES)",
      "",
      "**When the prefix contains `:voice` (e.g. `[PAILot:voice]`, `[Whazaa:voice]`), you MUST reply with the `_tts` tool, NEVER the `_send` tool.**",
      "- `[PAILot:voice]` → `pailot_tts` (NEVER pailot_send)",
      "- `[Whazaa:voice]` → `whatsapp_tts` (NEVER whatsapp_send)",
      "- `[Telex:voice]` → `telegram_tts` (NEVER telegram_send)",
      "",
      "The user spoke to you. Speak back. Using `_send` for a voice message is a bug.",
      "",
      "### Message Source Detection",
      "",
      "| Prefix | Source | Reply with |",
      "|--------|--------|------------|",
      "| `[Whazaa]` | Text from WhatsApp | `whatsapp_send` (text reply) |",
      "| `[Whazaa:voice]` | Voice from WhatsApp | `whatsapp_tts` (voice reply) |",
      "| `[Telex]` | Text from Telegram | `telegram_send` (text reply) |",
      "| `[Telex:voice]` | Voice from Telegram | `telegram_tts` (voice reply) |",
      "| `[PAILot]` | Text from PAILot app | `pailot_send` (text reply) |",
      "| `[PAILot:voice]` | Voice from PAILot app | `pailot_tts` (VOICE reply — NEVER pailot_send) |",
      "| `[Session:NAME]` | Text from another Claude Code session | `aibroker_send_to_session` (reply to NAME) |",
      "| `[Task]` | A work order or question from the task bus | Act on it. If it asked anything, answer with `todoist_reply` using the id in the `[todoist:<taskId> in:<projectId>]` trailer — the asker filed it from a phone and will not see this terminal. File any follow-up task into that same `in:` project; NEVER create a project named after your alias, one already exists under a human-readable name (`todoist_ingress` action `resolve`). Leave the task open; closing it is theirs. |",
      "| `[Task:comment]` | A comment on a task you already handled | A correction or follow-up to work in flight, NOT a new work order — adjust what you did, do not start over. Same `[todoist:…]` trailer, same reply route. |",
      "| _no prefix_ | User typing at the terminal | Terminal only — do NOT send to any channel |",
      "",
      "### Rules",
      "",
      "- **NEVER open a blocking interactive prompt for a channel message.** Multi-select menus and any modal that waits for a keypress freeze the session, and the person who sent the message is not at this terminal to answer it — so the session is stuck until someone notices, and the answer they wanted never comes. This applies to every prefixed message: `[Task]`, `[Task:comment]`, `[PAILot]`, `[Whazaa]`, `[Telex]`, `[Session:…]`. Instead: decide it yourself if the choice is routine, and say which option you took and why; if it genuinely needs the human, ASK ON THE CHANNEL IT CAME FROM (`todoist_reply`, `pailot_send`, `whatsapp_send`, …) and stop there. A question asked on the channel can be answered from a phone; a modal cannot.",
      "- **A task you create in an ingress project comes straight back to you.** Filing there fires `item:added`, routing dispatches it, and you receive your own note as a work order — a session probing due-date parsing once handed itself twelve tasks in four minutes. Use `todoist_task`, which marks it so that echo is dropped. Scheduling your own work for LATER is fine and intended: a marked task's `reminder:fired` is still delivered, so a click-to-run task with a recurrence works exactly as you would want. Only use a raw Todoist tool for projects that reach nobody.",
      "- **Strip the prefix** before processing the message content.",
      "- **Match the medium**: text in → text out, voice in → voice out. This is NON-NEGOTIABLE.",
      "- **Same content**: send the same response as the terminal — do not shorten or paraphrase.",
      "- **Text formatting**: use **bold** and *italic* only for whatsapp_send/telegram_send. No markdown headers or code blocks.",
      "- **Voice formatting**: NEVER use asterisks or any markdown in _tts messages. TTS reads them literally as 'asterisk'. Write plain conversational text only.",
      "- **Acknowledge long tasks**: if a prefixed task will take more than a few seconds, immediately send a brief ack via the matching _tts or _send tool (match the medium!) BEFORE starting work. Never leave the client silent.",
      "- **Session messages**: `[Session:NAME]` messages come from another Claude Code session. Process the request, then send your full response back via `aibroker_send_to_session(target=NAME, message=YOUR_RESPONSE)`. Do NOT just answer in the terminal — the sender is waiting via `aibroker_receive`. IMPORTANT: When calling `aibroker_send_to_session`, do NOT include a `[Session:...]` prefix in your message — the hub auto-prepends it.",
      "- **Task messages**: `[Task]` is a dispatched work order, not a question. Act on it. Do NOT reply — the process that sent it has already exited, so there is no reply channel and the usual 'respond in kind' rule does not apply. Report by closing it on the tracker (`pai task done <id>`); if you are blocked or disagree, file that back with `pai task add` rather than replying. The message body restates this, and the body wins if they ever disagree.",
      "- **Per-message toggle**: this switches automatically with every message. No manual on/off needed.",
      "",
      "### Companion App Message Detection",
      "",
      "All outgoing messages are tagged so companion apps can distinguish PAI from user:",
      "- **Text messages**: prefixed with U+FEFF (zero-width no-break space, invisible in WhatsApp).",
      "- **All messages (text + voice)**: Baileys message IDs start with `3EB0`. User phone IDs do not.",
      "",
      "### Session Orchestration",
      "",
      "AIBroker can read terminal content from all running Claude Code sessions.",
      "Use these tools to check what other sessions are doing without switching to them.",
      "",
      "**Workflow for checking session status:**",
      "1. Call `aibroker_session_content()` (no args = all sessions, or pass `sessionId` for one)",
      "2. You receive raw terminal output + `atPrompt` (idle) flag + `changed` (content changed since last check)",
      "3. If `changed` is true: parse the raw content into a 1-2 sentence summary",
      "4. Cache your summary via `aibroker_cache_status({ sessionId, summary, contentHash, state })`",
      "5. If `changed` is false: use `cachedSummary` from the response (skip re-parsing)",
      "",
      "**Quick status check (no re-parsing):**",
      "Call `aibroker_get_cached_status()` to get all previously cached summaries instantly.",
      "",
      "**State mapping:**",
      "- `atPrompt: true` → state: `idle` (session waiting for input)",
      "- `atPrompt: false` → state: `busy` (Claude is working)",
      "",
      "**Response format:**",
      "Present status as a compact table with session name, state (idle/busy), and summary.",
      "For voice responses, read it as a natural sentence.",
    ].join("\n"),
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// Hub-Level Tools (aibroker_*)
// ═══════════════════════════════════════════════════════════════════════════

server.tool("aibroker_status", "Hub health: version, adapters, sessions, adapter health", {}, async () => {
  try {
    const r = await hub.call_raw("status", {});
    return ok(JSON.stringify(r, null, 2));
  } catch (e) { return err(e); }
});

server.tool("aibroker_aibp_status", "AIBP protocol status: registered plugins, channels, commands", {}, async () => {
  try {
    const r = await hub.call_raw("aibp_status", {});
    return ok(JSON.stringify(r, null, 2));
  } catch (e) { return err(e); }
});

server.tool("aibroker_adapters", "List registered adapters", {}, async () => {
  try {
    const r = await hub.call_raw("adapter_list", {});
    return ok(JSON.stringify(r, null, 2));
  } catch (e) { return err(e); }
});

server.tool("aibroker_sessions", "List Claude sessions managed by the hub", {}, async () => {
  try {
    const r = await hub.call_raw("sessions", {});
    return ok(JSON.stringify(r, null, 2));
  } catch (e) { return err(e); }
});

server.tool(
  "aibroker_switch",
  "Switch the active Claude session",
  { target: z.string().describe("Session number (1-based) or name substring") },
  async ({ target }) => {
    try {
      const r = await hub.call_raw("switch", { target });
      return ok(`Switched to ${(r as any).name ?? target}`);
    } catch (e) { return err(e); }
  },
);

server.tool(
  "aibroker_end_session",
  "End a Claude session (closes tab, removes from registry)",
  { target: z.string().describe("Session number or name substring") },
  async ({ target }) => {
    try {
      const r = await hub.call_raw("end_session", { target });
      return ok(`Ended session ${(r as any).name ?? target}`);
    } catch (e) { return err(e); }
  },
);

server.tool(
  "aibroker_rename",
  "Rename the current Claude session (tab title + registry)",
  { name: z.string().min(1).describe("New session name") },
  async ({ name }) => {
    try {
      const r = await hub.call_raw("rename", { name });
      return ok(`Session renamed to "${(r as any).name ?? name}"`);
    } catch (e) { return err(e); }
  },
);

server.tool(
  "aibroker_get_persistent_name",
  "Get the persisted user-chosen name for the current or a specific iTerm2 session. Returns null if not named.",
  { itermSessionId: z.string().optional().describe("iTerm2 session UUID. Defaults to the caller's session.") },
  async ({ itermSessionId }) => {
    try {
      const r = await hub.call_raw("get_persistent_name", { itermSessionId });
      const name = (r as any).name;
      return ok(name !== null ? `Persistent name: "${name}"` : "No persistent name set for this session");
    } catch (e) { return err(e); }
  },
);

server.tool("aibroker_discover", "Re-scan iTerm2 sessions and refresh registry", {}, async () => {
  try {
    const r = await hub.call_raw("discover", {});
    return ok(JSON.stringify(r, null, 2));
  } catch (e) { return err(e); }
});

server.tool(
  "aibroker_voice_config",
  "Get or set TTS voice configuration",
  {
    action: z.enum(["get", "set"]).describe("Action: get or set"),
    defaultVoice: z.string().optional().describe("Default TTS voice (e.g. 'bm_fable')"),
    voiceMode: z.boolean().optional().describe("Enable/disable voice mode"),
    localMode: z.boolean().optional().describe("Enable/disable local speaker mode"),
    personas: z.record(z.string(), z.string()).optional().describe("Persona name -> voice mapping"),
  },
  async ({ action, defaultVoice, voiceMode, localMode, personas }) => {
    try {
      const updates: Record<string, unknown> = {};
      if (defaultVoice !== undefined) updates.defaultVoice = defaultVoice;
      if (voiceMode !== undefined) updates.voiceMode = voiceMode;
      if (localMode !== undefined) updates.localMode = localMode;
      if (personas !== undefined) updates.personas = personas;
      const r = await hub.call_raw("voice_config", { action, ...updates });
      return ok(JSON.stringify(r, null, 2));
    } catch (e) { return err(e); }
  },
);

server.tool(
  "aibroker_speak",
  "Speak text aloud through Mac speakers using Kokoro TTS (local, no network send)",
  {
    text: z.string().min(1).describe("Text to speak"),
    voice: z.string().optional().describe("Voice name (e.g. 'bm_fable', 'af_bella')"),
  },
  async ({ text, voice }) => {
    try {
      await hub.call_raw("speak", { text, voice });
      return ok("Speaking.");
    } catch (e) { return err(e); }
  },
);

server.tool(
  "aibroker_dictate",
  "Record from Mac mic, transcribe with Whisper, return text. Stops on ~2s silence.",
  {
    maxDuration: z.number().min(5).max(300).optional().describe("Max recording seconds (default 60)"),
  },
  async ({ maxDuration }) => {
    try {
      const r = await hub.call_raw("dictate", { maxDuration }) as any;
      if (!r.text) return ok("No speech detected.");
      return ok(`Transcribed: ${r.text}`);
    } catch (e) { return err(e); }
  },
);

server.tool(
  "aibroker_generate_image",
  "Generate an image from a text prompt",
  {
    prompt: z.string().min(1).describe("Image description"),
    source: z.string().optional().describe("Adapter to deliver result to (e.g. 'whazaa')"),
    recipient: z.string().optional().describe("Recipient within that adapter"),
    width: z.number().optional().describe("Image width"),
    height: z.number().optional().describe("Image height"),
  },
  async ({ prompt, source, recipient, width, height }) => {
    try {
      const r = await hub.call_raw("generate_image", { prompt, source, recipient, width, height });
      return ok(JSON.stringify(r, null, 2));
    } catch (e) { return err(e); }
  },
);

server.tool(
  "aibroker_command",
  "Execute a slash command directly through the hub command handler",
  { text: z.string().min(1).describe("The slash command (e.g. '/s', '/ss', '/restart')") },
  async ({ text }) => {
    try {
      const r = await hub.call_raw("command", { text });
      return ok(`Executed: ${text}`);
    } catch (e) { return err(e); }
  },
);

server.tool("aibroker_pai_projects", "List PAI named projects", {}, async () => {
  try {
    const r = await hub.call_raw("pai_projects", {});
    return ok(JSON.stringify(r, null, 2));
  } catch (e) { return err(e); }
});

server.tool(
  "aibroker_pai_launch",
  "Launch a PAI named project in a new iTerm2 tab",
  { name: z.string().min(1).describe("Project name") },
  async ({ name }) => {
    try {
      const r = await hub.call_raw("pai_launch", { name });
      return ok(JSON.stringify(r, null, 2));
    } catch (e) { return err(e); }
  },
);

// ── Session Orchestration ──

server.tool(
  "aibroker_session_content",
  "Read raw terminal content from iTerm2 Claude Code sessions. Returns last N lines + busy/idle state + whether content changed since last probe. Omit sessionId for all sessions.",
  {
    sessionId: z.string().optional().describe("iTerm2 session ID. Omit to read all sessions."),
    lines: z.number().min(10).max(500).optional().describe("Number of lines to read (default 100)"),
  },
  async ({ sessionId, lines }) => {
    try {
      const r = await hub.call_raw("session_content", { sessionId, lines });
      return ok(JSON.stringify(r, null, 2));
    } catch (e) { return err(e); }
  },
);

server.tool(
  "aibroker_cache_status",
  "Store a parsed summary for a session. Call after parsing raw terminal content from aibroker_session_content. The summary is cached so future probes skip re-parsing if content unchanged.",
  {
    sessionId: z.string().describe("iTerm2 session ID"),
    sessionName: z.string().optional().describe("Human-readable session name"),
    summary: z.string().describe("1-2 sentence parsed summary of what the session is doing"),
    contentHash: z.string().optional().describe("Content hash from session_content (for change detection)"),
    state: z.enum(["idle", "busy", "error", "disconnected"]).optional().describe("Session state (default: idle)"),
  },
  async ({ sessionId, sessionName, summary, contentHash, state }) => {
    try {
      const r = await hub.call_raw("cache_status", { sessionId, sessionName, summary, contentHash, state });
      return ok(JSON.stringify(r, null, 2));
    } catch (e) { return err(e); }
  },
);

server.tool(
  "aibroker_get_cached_status",
  "Retrieve cached session status summaries without re-probing terminal content. Fast lookup of previously parsed summaries.",
  {
    sessionId: z.string().optional().describe("iTerm2 session ID. Omit for all cached snapshots."),
  },
  async ({ sessionId }) => {
    try {
      const r = await hub.call_raw("get_cached_status", { sessionId });
      return ok(JSON.stringify(r, null, 2));
    } catch (e) { return err(e); }
  },
);

server.tool(
  "todoist_ingress",
  "List, resolve or change which Todoist projects may reach a session. BEFORE creating any Todoist project for a session, call action:\"resolve\" with that session's owner name — a project almost certainly already exists under a human-readable name (`Jobs Matthias`) that will not match the alias you know yourself by (`jobs-matthias`), and creating a second one splits the work so the user watches the wrong list. A task filed into an allowed project becomes an instruction a session runs with the user's full rights, so granting is a security boundary: grant deliberately, never speculatively, and tell the user what you granted. Takes effect immediately — no daemon restart. Every change is recorded in the audit trail.",
  {
    action: z.enum(["list", "resolve", "add", "remove"]).describe("list (default), resolve (find the project for an owner), add, or remove"),
    projectId: z.string().optional().describe("Todoist project id. Required for add and remove."),
    owner: z.string().optional().describe("Session that owns work filed there — a curated PAI alias, not merely a running tab name. Omit to fall through to the default owner."),
    projectName: z.string().optional().describe("Human-readable label, so the stored grant is readable later"),
  },
  async ({ action, projectId, owner, projectName }) => {
    try {
      const r = await hub.call_raw("todoist_ingress", { action, projectId, owner, projectName });
      return ok(JSON.stringify(r, null, 2));
    } catch (e) { return err(e); }
  },
);

server.tool(
  "todoist_task",
  "Create a Todoist task from a session. ALWAYS use this instead of a generic Todoist tool when the project is one that reaches a session (anything under the ingress allowlist): a task you file there fires item:added, routing sends it straight back, and you receive your own note as a work order you never asked for. This marks the task so that echo is dropped. Scheduling your own work still works and is encouraged — a marked task's reminder:fired IS delivered, so give it a dueString with a reminder when you want it to come back to you later. Due dates alone fire nothing.",
  {
    content: z.string().min(1).describe("Task title. The 🤖 mark is added automatically; do not add it yourself."),
    projectId: z.string().optional().describe("Todoist project id. Use the `in:` value from the [todoist:…] trailer, or todoist_ingress action resolve. Omitted means Inbox."),
    description: z.string().optional().describe("Longer body, notes, runbook"),
    dueString: z.string().optional().describe("Natural language due date, e.g. \"tomorrow at 09:00\" or \"every monday\""),
  },
  async ({ content, projectId, description, dueString }) => {
    try {
      const r = await hub.call_raw("todoist_task", { content, projectId, description, dueString });
      return ok(`Created task ${(r as any).taskId ?? ""}`);
    } catch (e) { return err(e); }
  },
);

server.tool(
  "todoist_reply",
  "Answer on the Todoist task a [Task] work order came from, as a comment. If the task arrived as a TRIGGER (a recurring task you were dispatched from), complete the task and then pass release:true — otherwise the pai-running claim stays on the task and the next scheduled run is silently suppressed. Use this whenever a task asked a question — the reply appears under the task on the asker's phone instead of only in this terminal. The 🤖 prefix is added automatically so the comment is not read back as a new instruction. Does NOT complete the task: leave that to the human, or the answer disappears from their list with it.",
  {
    taskId: z.string().min(1).describe("Todoist task id, as reported in the audit trail for the delivery"),
    text: z.string().min(1).describe("The answer. Plain text or Markdown; do not add the 🤖 prefix yourself."),
    release: z.boolean().optional().describe("Set true when you have FINISHED a run that arrived as a trigger (a recurring task you were dispatched from). COMPLETE THE TASK FIRST, then release: the release is refused while the task's due date shows the completion has not landed, because dropping the claim on a still-overdue task makes the next poll run it again. Leaving the claim set costs one missed run; dropping it early costs a duplicate. Check `releaseRefused` in the result."),
  },
  async ({ taskId, text, release }) => {
    try {
      const r = await hub.call_raw("todoist_reply", { taskId, text, release, sessionId: getSessionId() });
      return ok(`Replied on task ${(r as any).taskId ?? taskId}`);
    } catch (e) { return err(e); }
  },
);

server.tool(
  "todoist_mirror",
  "Run the Todoist comment mirror now: every comment added since the last pass becomes a task in the mirror project, grouped into an auto-created section named after the project it came from, linking back to the conversation. Sections this tool created are removed again once their items are all dealt with. The daemon also runs this every five minutes — call it to force a pass immediately after replying. Requires TODOIST_MIRROR_PROJECT in ~/.aibroker/env.",
  {},
  async () => {
    try {
      const r = await hub.call_raw("todoist_mirror", {}) as any;
      return ok(`Mirrored ${r.mirrored}, sections +${r.sectionsCreated}/-${r.sectionsRemoved}${r.skipped ? `, ${r.skipped} deferred to the next pass` : ""}`);
    } catch (e) { return err(e); }
  },
);

server.tool(
  "todoist_inbox",
  "Which Todoist tasks have new comments since you last looked. Answers the question Todoist itself cannot: it does not notify an account about its own activity, and every comment a session writes is written as the account owner, so replies land invisibly in a tree of hundreds of tasks. Reads the activity log in one request, groups comments by task, and returns each task's title, newest comment and a direct link. Pass markSeen:true only when the human has actually been shown the digest — it advances the read marker, and advancing it unseen loses the backlog. Pass push:true to send it to the PAILot app.",
  {
    since: z.string().optional().describe("ISO timestamp to look back from, e.g. '2026-08-01T00:00:00Z'. Defaults to the stored read marker; pass this to look further back WITHOUT disturbing that marker."),
    markSeen: z.boolean().optional().describe("Advance the read marker to the newest comment in this digest. Only set once the human has seen it."),
    push: z.boolean().optional().describe("Also send the digest to the PAILot app as a message."),
  },
  async ({ since, markSeen, push }) => {
    try {
      const r = await hub.call_raw("todoist_inbox", { since, markSeen, push, sessionId: getSessionId() }) as any;
      return ok(r.text ?? "(no digest)");
    } catch (e) { return err(e); }
  },
);

server.tool(
  "aibroker_send_to_session",
  "Send a message to another iTerm2 session by typing it into the session's terminal AND depositing it into that session's AIBP mailbox. The target can be a session index (e.g. '2'), a session name substring, or an iTerm2 session UUID. The receiving session can read structured messages via aibroker_receive. NOTE: The [Session:SENDER] prefix is auto-prepended by the hub — do NOT include it in the message. The result distinguishes `delivered: true` (the target was observed taking it) from `delivered: false, queued: true` (typed but unconfirmed — the target is probably mid-task; the message is in its mailbox). Do not read ok:true as \"they have seen it\".",
  {
    target: z.string().min(1).describe("Session to send to: index (1-based), name substring, or iTerm2 session UUID"),
    message: z.string().min(1).describe("The raw message content. Do NOT include a [Session:...] prefix — the hub auto-prepends [Session:SENDER_NAME] for routing."),
  },
  async ({ target, message }) => {
    try {
      const r = await hub.call_raw("send_to_session", { target, message }) as any;
      return ok(`Sent to session "${r.name ?? target}".`);
    } catch (e) { return err(e); }
  },
);

server.tool(
  "aibroker_receive",
  "Drain messages sent to this session via aibroker_send_to_session. Returns structured messages with sender, content, and timestamp. If timeout is set, polls until a message arrives or timeout expires (max 120s). Without timeout, returns immediately.",
  {
    timeout: z.number().optional().describe("Seconds to wait for a message (max 120). Omit for immediate drain."),
  },
  async ({ timeout }) => {
    try {
      const sessionId = getSessionId();
      const maxWait = Math.min(timeout ?? 0, 120) * 1000;
      const pollInterval = 2000;
      const deadline = Date.now() + maxWait;

      let msgs: Array<{ from: string; content: string; timestamp: number }> = [];

      // First immediate check
      const r = await hub.call_raw("session_mailbox_receive", { sessionId }) as any;
      msgs = r?.messages ?? [];

      // If no messages and timeout requested, poll
      while (msgs.length === 0 && maxWait > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
        const r2 = await hub.call_raw("session_mailbox_receive", { sessionId }) as any;
        msgs = r2?.messages ?? [];
      }

      if (msgs.length === 0) return ok("No messages received.");
      const lines = msgs.map((m) => `[${new Date(m.timestamp).toISOString()}] From ${m.from}: ${m.content}`);
      return ok(lines.join("\n"));
    } catch (e) { return err(e); }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// WhatsApp Tools (whatsapp_*) — proxied to whazaa adapter
// ═══════════════════════════════════════════════════════════════════════════

server.tool("whatsapp_status", "Check WhatsApp connection state", {}, async () => {
  try {
    const r = await adapterCall("whazaa", "status");
    const s = r as any;
    if (s.awaitingQR) return ok("Awaiting QR scan. Check the watcher terminal.");
    if (s.connected && s.phoneNumber) return ok(`Connected. Phone: +${s.phoneNumber}`);
    return ok("Disconnected. Reconnecting in background.");
  } catch (e) { return err(e); }
});

server.tool(
  "whatsapp_send",
  "Send a WhatsApp message. ONLY use when the user's message started with [Whazaa] prefix. NEVER use for terminal messages (no prefix). Without recipient: self-chat. Set channel='pailot' to send only to PAILot app.",
  {
    message: z.string().min(1).describe("Message text"),
    recipient: z.string().optional().describe("Phone number, JID, or contact name. Omit for self-chat."),
    voice: z.string().optional().describe("If set, send as TTS voice note. 'true'/'default' for default voice, or voice name."),
    channel: z.enum(["whatsapp", "pailot"]).optional().describe("'pailot' sends only to PAILot. Default: whatsapp."),
  },
  async ({ message, recipient, voice, channel }) => {
    try {
      if (voice !== undefined && voice !== "") {
        const explicitVoice = (voice === "true" || voice === "default") ? undefined : voice;
        await adapterCall("whazaa", "tts", { text: message, voice: explicitVoice, jid: recipient, channel });
        return ok("Sent.");
      }
      await adapterCall("whazaa", "send", { message, recipient, channel });
      return ok("Sent.");
    } catch (e) { return err(e); }
  },
);

server.tool(
  "whatsapp_tts",
  "Convert text to speech and send as WhatsApp voice note using Kokoro TTS (local). ONLY use when the user's message started with [Whazaa:voice] prefix. NEVER use for terminal messages (no prefix).",
  {
    message: z.string().min(1).describe("Text to speak"),
    voice: z.string().optional().describe("Voice name (e.g. 'af_bella', 'bm_george')"),
    recipient: z.string().optional().describe("Phone number, JID, or contact name. Omit for self-chat."),
    channel: z.enum(["whatsapp", "pailot"]).optional().describe("'pailot' sends only to PAILot."),
  },
  async ({ message, voice, recipient, channel }) => {
    try {
      const r = await adapterCall("whazaa", "tts", { text: message, voice, jid: recipient, channel }) as any;
      const chunks = r?.chunks ?? 1;
      return ok(chunks > 1 ? `Sent ${chunks} voice notes.` : "Sent.");
    } catch (e) { return err(e); }
  },
);

server.tool(
  "whatsapp_send_file",
  "Send a file via WhatsApp. Set prettify=true to convert text/md to formatted messages.",
  {
    filePath: z.string().min(1).describe("Absolute path to the file"),
    recipient: z.string().optional().describe("Phone number, JID, or name. Omit for self-chat."),
    caption: z.string().optional().describe("Caption for the file"),
    prettify: z.boolean().optional().describe("Convert text/md files to WhatsApp-formatted messages"),
  },
  async ({ filePath, recipient, caption, prettify }) => {
    try {
      await adapterCall("whazaa", "send_file", { filePath, recipient, caption, prettify });
      return ok("Sent.");
    } catch (e) { return err(e); }
  },
);

server.tool(
  "whatsapp_receive",
  "Drain queued incoming WhatsApp messages. Use from='all' for all chats.",
  {
    from: z.string().optional().describe("Sender filter: phone, JID, name, or 'all'. Omit for self-chat."),
  },
  async ({ from }) => {
    try {
      const r = await adapterCall("whazaa", "receive", { from }) as any;
      const msgs = r?.messages ?? [];
      if (msgs.length === 0) return ok("No new messages.");
      const lines = msgs.map((m: any) => `[${new Date(m.timestamp).toISOString()}] ${m.body}`);
      return ok(lines.join("\n"));
    } catch (e) { return err(e); }
  },
);

server.tool(
  "whatsapp_contacts",
  "List recently seen WhatsApp contacts",
  {
    search: z.string().optional().describe("Filter by name or phone"),
    limit: z.number().min(1).max(200).optional().describe("Max results (default 50)"),
  },
  async ({ search, limit }) => {
    try {
      const r = await adapterCall("whazaa", "contacts", { search, limit }) as any;
      const contacts = r?.contacts ?? [];
      if (contacts.length === 0) return ok(search ? `No contacts matching '${search}'.` : "No contacts seen yet.");
      const lines = contacts.map((c: any) => `${c.name ?? ""} +${c.phoneNumber} (${c.jid})`);
      return ok(`${contacts.length} contact(s):\n${lines.join("\n")}`);
    } catch (e) { return err(e); }
  },
);

server.tool(
  "whatsapp_chats",
  "List WhatsApp chat conversations",
  {
    search: z.string().optional().describe("Filter by name or phone"),
    limit: z.number().min(1).max(200).optional().describe("Max results (default 50)"),
  },
  async ({ search, limit }) => {
    try {
      const r = await adapterCall("whazaa", "chats", { search, limit }) as any;
      const chats = r?.chats ?? [];
      if (chats.length === 0) return ok(search ? `No chats matching '${search}'.` : "No chats found.");
      const lines = chats.map((c: any) => {
        const unread = c.unreadCount > 0 ? ` [${c.unreadCount} unread]` : "";
        return `${c.name} (${c.jid})${unread}`;
      });
      return ok(`${chats.length} chat(s):\n${lines.join("\n")}`);
    } catch (e) { return err(e); }
  },
);

server.tool(
  "whatsapp_wait",
  "Long-poll for next incoming WhatsApp message (blocks until arrival or timeout)",
  {
    timeout: z.number().min(1).max(300).optional().describe("Max seconds to wait (default 120)"),
  },
  async ({ timeout }) => {
    try {
      const r = await adapterCall("whazaa", "wait", { timeoutMs: (timeout ?? 120) * 1000 }) as any;
      const msgs = r?.messages ?? [];
      if (msgs.length === 0) return ok("No messages received (timed out).");
      const lines = msgs.map((m: any) => `[${new Date(m.timestamp).toISOString()}] ${m.body}`);
      return ok(lines.join("\n"));
    } catch (e) { return err(e); }
  },
);

server.tool("whatsapp_login", "Trigger new WhatsApp QR pairing flow", {}, async () => {
  try {
    const r = await adapterCall("whazaa", "login") as any;
    return ok(r?.message ?? "Login flow triggered. Check watcher terminal for QR.");
  } catch (e) { return err(e); }
});

server.tool(
  "whatsapp_history",
  "Fetch message history for a WhatsApp chat",
  {
    jid: z.string().min(1).describe("Chat JID or phone number"),
    count: z.number().min(1).max(500).optional().describe("Number of messages (default 50)"),
  },
  async ({ jid, count }) => {
    try {
      const r = await adapterCall("whazaa", "history", { jid, count }) as any;
      const msgs = r?.messages ?? [];
      if (msgs.length === 0) return ok("No messages found.");
      const lines = msgs.map((m: any) => `[${m.date}] ${m.fromMe ? "Me" : (m.pushName ?? "Them")}: ${m.text}`);
      return ok(`${msgs.length} message(s):\n${lines.join("\n")}`);
    } catch (e) { return err(e); }
  },
);

server.tool("whatsapp_restart", "Restart the WhatsApp watcher service (launchd)", {}, async () => {
  try {
    const r = await adapterCall("whazaa", "restart");
    return ok(JSON.stringify(r, null, 2));
  } catch (e) { return err(e); }
});

// ═══════════════════════════════════════════════════════════════════════════
// Telegram Tools (telegram_*) — proxied to telex adapter
// ═══════════════════════════════════════════════════════════════════════════

server.tool("telegram_status", "Check Telegram connection status", {}, async () => {
  try {
    const r = await adapterCall("telex", "status");
    return ok(JSON.stringify(r, null, 2));
  } catch (e) { return err(e); }
});

server.tool(
  "telegram_send",
  "Send a text message via Telegram. ONLY use when the user's message started with [Telex] prefix. NEVER use for terminal messages (no prefix).",
  {
    message: z.string().min(1).describe("Message text"),
    recipient: z.string().optional().describe("Username, phone, chat ID, or name. Default: Saved Messages."),
    voice: z.boolean().optional().describe("If true, send as voice note via TTS"),
  },
  async ({ message, recipient, voice }) => {
    try {
      if (voice) {
        await adapterCall("telex", "tts", { text: message, recipient });
        return ok("Sent.");
      }
      await adapterCall("telex", "send", { message, recipient });
      return ok("Sent.");
    } catch (e) { return err(e); }
  },
);

server.tool(
  "telegram_tts",
  "Send a voice note via Telegram (Kokoro TTS). ONLY use when the user's message started with [Telex:voice] prefix. NEVER use for terminal messages (no prefix).",
  {
    text: z.string().min(1).describe("Text to speak"),
    recipient: z.string().optional().describe("Recipient. Default: Saved Messages."),
    voice: z.string().optional().describe("Voice name"),
  },
  async ({ text, recipient, voice }) => {
    try {
      const r = await adapterCall("telex", "tts", { text, recipient, voice }) as any;
      const chunks = r?.chunks ?? 1;
      return ok(chunks > 1 ? `Sent ${chunks} voice notes.` : "Sent.");
    } catch (e) { return err(e); }
  },
);

server.tool(
  "telegram_send_file",
  "Send a file via Telegram",
  {
    filePath: z.string().min(1).describe("Absolute path to the file"),
    recipient: z.string().optional().describe("Recipient. Default: Saved Messages."),
    caption: z.string().optional().describe("Caption"),
    prettify: z.boolean().optional().describe("Convert text/md to formatted Telegram messages"),
  },
  async ({ filePath, recipient, caption, prettify }) => {
    try {
      await adapterCall("telex", "send_file", { filePath, recipient, caption, prettify });
      return ok("Sent.");
    } catch (e) { return err(e); }
  },
);

server.tool(
  "telegram_receive",
  "Drain queued incoming Telegram messages",
  {
    from: z.string().optional().describe("Source: omit for self, 'all' for all, or chat ID/name"),
  },
  async ({ from }) => {
    try {
      const r = await adapterCall("telex", "receive", { from }) as any;
      const msgs = r?.messages ?? [];
      if (msgs.length === 0) return ok("No new messages.");
      const lines = msgs.map((m: any) => `[${new Date(m.timestamp).toISOString()}] ${m.body}`);
      return ok(lines.join("\n"));
    } catch (e) { return err(e); }
  },
);

server.tool(
  "telegram_contacts",
  "List Telegram contacts",
  {
    search: z.string().optional().describe("Filter by name/username"),
    limit: z.number().optional().describe("Max results"),
  },
  async ({ search, limit }) => {
    try {
      const r = await adapterCall("telex", "contacts", { search, limit });
      return ok(JSON.stringify(r, null, 2));
    } catch (e) { return err(e); }
  },
);

server.tool(
  "telegram_chats",
  "List Telegram chats",
  {
    search: z.string().optional().describe("Filter"),
    limit: z.number().optional().describe("Max results (default 50)"),
  },
  async ({ search, limit }) => {
    try {
      const r = await adapterCall("telex", "chats", { search, limit });
      return ok(JSON.stringify(r, null, 2));
    } catch (e) { return err(e); }
  },
);

server.tool(
  "telegram_wait",
  "Long-poll for incoming Telegram messages",
  {
    timeoutMs: z.number().optional().describe("Max wait in ms (default 120000)"),
  },
  async ({ timeoutMs }) => {
    try {
      const r = await adapterCall("telex", "wait", { timeoutMs }) as any;
      const msgs = r?.messages ?? [];
      if (msgs.length === 0) return ok("No messages received (timed out).");
      const lines = msgs.map((m: any) => `[${new Date(m.timestamp).toISOString()}] ${m.body}`);
      return ok(lines.join("\n"));
    } catch (e) { return err(e); }
  },
);

server.tool("telegram_login", "Trigger fresh Telegram authentication", {}, async () => {
  try {
    const r = await adapterCall("telex", "login");
    return ok(JSON.stringify(r, null, 2));
  } catch (e) { return err(e); }
});

server.tool(
  "telegram_history",
  "Get message history for a Telegram chat",
  {
    chatId: z.string().min(1).describe("Chat ID, username, or 'me' for Saved Messages"),
    count: z.number().optional().describe("Number of messages (default 20)"),
  },
  async ({ chatId, count }) => {
    try {
      const r = await adapterCall("telex", "history", { chatId, count }) as any;
      const msgs = r?.messages ?? [];
      if (msgs.length === 0) return ok("No messages found.");
      const lines = msgs.map((m: any) => `[${m.date}] ${m.fromMe ? "Me" : "Them"}: ${m.text}`);
      return ok(`${msgs.length} message(s):\n${lines.join("\n")}`);
    } catch (e) { return err(e); }
  },
);

server.tool("telegram_restart", "Restart the Telegram watcher service", {}, async () => {
  try {
    const r = await adapterCall("telex", "restart");
    return ok(JSON.stringify(r, null, 2));
  } catch (e) { return err(e); }
});

// ═══════════════════════════════════════════════════════════════════════════
// PAILot Tools (pailot_*) — direct hub calls
// ═══════════════════════════════════════════════════════════════════════════

server.tool(
  "pailot_send",
  "Send a text message to the PAILot mobile app. ONLY use when the user's message started with [PAILot] prefix. NEVER use for terminal messages (no prefix). Route replies to the SAME channel the message came from.",
  { message: z.string().min(1).describe("Message text") },
  async ({ message }) => {
    try {
      const sessionId = getSessionId();
      await hub.call_raw("pailot_send", { text: message, sessionId });
      return ok("Sent.");
    } catch (e) { return err(e); }
  },
);

server.tool(
  "pailot_tts",
  "Send a voice note to the PAILot mobile app (Kokoro TTS). ONLY use when the user's message started with [PAILot:voice] prefix. NEVER use for terminal messages (no prefix).",
  {
    message: z.string().min(1).describe("Text to speak"),
    voice: z.string().optional().describe("Voice name"),
  },
  async ({ message, voice }) => {
    try {
      const sessionId = getSessionId();
      const r = await hub.call_raw("pailot_send", { text: message, voice: true, voiceName: voice, sessionId }) as any;
      const chunks = r?.chunks ?? 1;
      return ok(chunks > 1 ? `Sent ${chunks} voice notes.` : "Sent.");
    } catch (e) { return err(e); }
  },
);

server.tool(
  "pailot_send_file",
  "Send a file (image, PDF, document) to the PAILot mobile app. Reads the file from disk, encodes it, and delivers via MQTT.",
  {
    filePath: z.string().min(1).describe("Absolute path to the file"),
    caption: z.string().optional().describe("Caption or description for the file"),
  },
  async ({ filePath, caption }) => {
    try {
      const { readFileSync, existsSync } = await import("node:fs");
      const { extname } = await import("node:path");
      if (!existsSync(filePath)) return err(new Error(`File not found: ${filePath}`));
      const buf = readFileSync(filePath);
      const b64 = buf.toString("base64");
      const ext = extname(filePath).toLowerCase();
      // Determine if it's an image or a generic file
      const imageExts = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"];
      const mimeMap: Record<string, string> = {
        ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
        ".svg": "image/svg+xml", ".pdf": "application/pdf",
        ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".txt": "text/plain", ".csv": "text/csv", ".json": "application/json",
        ".md": "text/markdown", ".html": "text/html", ".htm": "text/html",
        ".xml": "application/xml", ".yaml": "text/yaml", ".yml": "text/yaml",
        ".ts": "text/plain", ".js": "text/plain", ".py": "text/plain",
        ".sh": "text/plain", ".dart": "text/plain", ".swift": "text/plain",
        ".zip": "application/zip", ".gz": "application/gzip",
      };
      const mimeType = mimeMap[ext] ?? "application/octet-stream";
      const sessionId = getSessionId();
      if (imageExts.includes(ext)) {
        await hub.call_raw("pailot_send", { imageBase64: b64, caption: caption ?? filePath.split("/").pop(), mimeType, sessionId });
      } else {
        // For non-image files, send as text with file info (app doesn't render arbitrary files yet)
        await hub.call_raw("pailot_send", { imageBase64: b64, caption: caption ?? filePath.split("/").pop(), mimeType, sessionId });
      }
      const sizeKB = Math.round(buf.length / 1024);
      return ok(`Sent ${filePath.split("/").pop()} (${sizeKB} KB).`);
    } catch (e) { return err(e); }
  },
);

server.tool(
  "pailot_receive",
  "Drain queued incoming PAILot messages",
  {},
  async () => {
    try {
      const r = await hub.call_raw("pailot_receive", {}) as any;
      const msgs = r?.messages ?? [];
      if (msgs.length === 0) return ok("No new messages.");
      const lines = msgs.map((m: any) => `[${new Date(m.timestamp).toISOString()}] ${m.body}`);
      return ok(lines.join("\n"));
    } catch (e) { return err(e); }
  },
);

server.tool(
  "pailot_debug_state",
  "Ask the PAILot app to report its current session list exactly as it is rendering it — including the resolved displayed name, raw paiName, tabTitle, source, and activeSessionId. Use this to debug name-resolution issues on the mobile side. Requires the app to be connected; times out after ~5 s if the app is unreachable.",
  {
    timeout: z.number().min(1).max(30).optional().describe("Seconds to wait for the app response (default 5)"),
  },
  async ({ timeout }) => {
    try {
      const r = await hub.call_raw("pailot_debug_state", { timeout }) as any;
      return ok(JSON.stringify(r, null, 2));
    } catch (e) { return err(e); }
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// OTA Tools
// ═══════════════════════════════════════════════════════════════════════════

server.tool(
  "ota_publish",
  "Publish an IPA or APK to the aibroker-ota install hub. Returns the install URL.",
  {
    slug: z.string().min(1).regex(/^[a-z0-9-]+$/).describe("App slug (lowercase alphanumeric + hyphens)"),
    name: z.string().min(1).describe("Display name"),
    bundleId: z.string().min(1).describe("Bundle ID / package name"),
    version: z.string().min(1).describe("Version string"),
    platform: z.enum(["ios", "android"]).describe("ios or android"),
    filePath: z.string().min(1).describe("Absolute host path to .ipa or .apk"),
  },
  async ({ slug, name, bundleId, version, platform, filePath }) => {
    try {
      const { existsSync } = await import("node:fs");
      if (!existsSync(filePath)) return err(`File not found: ${filePath}`);

      // Use curl for multipart upload — avoids pulling in a fetch FormData polyfill
      const { execSync: exec } = await import("node:child_process");
      const result = exec(
        [
          "curl", "-sf", "-X", "POST",
          "http://127.0.0.1:8765/api/apps",
          "-F", `slug=${slug}`,
          "-F", `name=${name}`,
          "-F", `bundleId=${bundleId}`,
          "-F", `version=${version}`,
          "-F", `platform=${platform}`,
          "-F", `file=@${filePath}`,
        ].join(" "),
        { encoding: "utf-8" },
      );
      const parsed = JSON.parse(result);
      if (parsed.installUrl) {
        return ok(`Published. Install URL: ${parsed.installUrl}`);
      }
      return ok(result);
    } catch (e) { return err(e); }
  },
);

// ── Startup ──

async function main() {
  // Register with hub daemon (non-fatal if hub isn't running yet)
  hub.register().catch((e) => {
    process.stderr.write(`[aibroker-mcp] Hub not running: ${e}\n`);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  process.stderr.write(`[aibroker-mcp] Fatal: ${e}\n`);
  process.exit(1);
});
