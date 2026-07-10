/**
 * aibroker-hook-lib.mjs — shared helpers for AIBroker Claude Code hooks.
 *
 * These hooks make channel routing DETERMINISTIC instead of relying on the LLM
 * to remember to call pailot_tts / pailot_send. They are pure IPC clients:
 * they talk to the running AIBroker daemon over /tmp/aibroker.sock using the
 * exact same wire protocol as src/ipc/client.ts — no daemon changes required.
 *
 * Everything here is defensive: any failure resolves to a safe no-op so a hook
 * can never block or crash a Claude Code turn.
 */

import { connect } from "node:net";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const AIBROKER_SOCKET = "/tmp/aibroker.sock";
const IPC_TIMEOUT_MS = 8_000;

// ── stdin / hook payload ──────────────────────────────────────────────────

/** Read all of stdin as a string. */
export async function readStdin() {
  let input = "";
  const decoder = new TextDecoder();
  try {
    for await (const chunk of process.stdin) {
      input += decoder.decode(chunk, { stream: true });
    }
  } catch {
    /* ignore */
  }
  return input;
}

/** Parse the Claude Code hook payload (Stop / PreToolUse share these fields). */
export function parseHookInput(raw) {
  try {
    const p = JSON.parse(raw);
    return {
      transcriptPath: p.transcript_path ?? "",
      cwd: p.cwd ?? process.cwd(),
      sessionId: p.session_id ?? "",
      toolName: p.tool_name ?? "",
      toolInput: p.tool_input ?? {},
      stopHookActive: p.stop_hook_active === true,
    };
  } catch {
    return null;
  }
}

// ── transcript parsing ────────────────────────────────────────────────────

export function readTranscriptLines(path) {
  try {
    return readFileSync(path, "utf-8").trim().split("\n");
  } catch {
    return [];
  }
}

function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/**
 * Return the text blocks of a message's content as a string array.
 * String content → [string]. Array content → the `text` blocks only
 * (tool_use / tool_result / image blocks are ignored).
 */
function textBlocks(content) {
  if (typeof content === "string") return content.trim() ? [content] : [];
  if (Array.isArray(content)) {
    const out = [];
    for (const c of content) {
      if (typeof c === "string" && c.trim()) out.push(c);
      else if (c && c.type === "text" && typeof c.text === "string" && c.text.trim()) out.push(c.text);
    }
    return out;
  }
  return [];
}

/**
 * Find the MOST RECENT genuine human prompt (a user-role message that carries
 * real text, not a bare tool_result). Returns { index, blocks } or null.
 *
 * Only the latest human prompt decides routing — this enforces per-message
 * independence (an earlier PAILot turn must not affect a later terminal turn).
 */
export function findLastHumanPrompt(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const e = parseLine(lines[i]);
    if (!e || e.type !== "user" || e.message?.role !== "user") continue;
    const blocks = textBlocks(e.message.content);
    if (blocks.length > 0) return { index: i, blocks };
  }
  return null;
}

const PREFIX_RE = /^\s*\[(PAILot|Whazaa|Telex)(:voice)?\]/i;

/**
 * Detect a channel prefix, anchored to the START of a text block. AIBroker
 * string-prepends the prefix (e.g. "[PAILot:voice] …"), so anchoring means a
 * terminal message that merely *mentions* the token cannot trigger delivery.
 * Returns { channel: 'pailot'|'whazaa'|'telex', voice: boolean } or null.
 */
export function detectChannel(blocks) {
  for (const b of blocks) {
    const m = b.match(PREFIX_RE);
    if (m) return { channel: m[1].toLowerCase(), voice: !!m[2] };
  }
  return null;
}

/**
 * Scan the current turn (lines AFTER the prompt) for which reply tools the
 * assistant actually called. Matches by tool-name substring so it works for the
 * fully-qualified MCP names (e.g. "mcp__aibroker__pailot_tts").
 */
export function scanReplyTools(lines, fromIdx) {
  let tts = false;
  let send = false;
  for (let i = fromIdx + 1; i < lines.length; i++) {
    const e = parseLine(lines[i]);
    if (!e || e.type !== "assistant" || !Array.isArray(e.message?.content)) continue;
    for (const c of e.message.content) {
      if (c && c.type === "tool_use" && typeof c.name === "string") {
        if (c.name.includes("pailot_tts")) tts = true;
        if (c.name.includes("pailot_send")) send = true;
      }
    }
  }
  return { tts, send };
}

/** The last non-empty assistant text in the current turn (the final answer). */
export function lastAssistantText(lines, fromIdx) {
  for (let i = lines.length - 1; i > fromIdx; i--) {
    const e = parseLine(lines[i]);
    if (!e || e.type !== "assistant") continue;
    const blocks = textBlocks(e.message?.content);
    if (blocks.length > 0) return blocks.join("\n\n").trim();
  }
  return "";
}

// ── IPC to the AIBroker daemon ────────────────────────────────────────────

/**
 * Call a daemon method over the Unix socket. Mirrors src/ipc/client.ts framing
 * (one JSON line in, one JSON line out). Passes through the terminal's session
 * identifiers so the daemon can resolve the correct target session. Resolves
 * { ok, result?, error? }; never rejects.
 */
export function ipcCall(method, params) {
  return new Promise((resolve) => {
    let done = false;
    let buffer = "";
    let timer = null;
    const finish = (v) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(v);
    };
    const sock = connect(AIBROKER_SOCKET, () => {
      const req = { id: randomUUID(), sessionId: process.env.TERM_SESSION_ID ?? "hook", method, params };
      if (process.env.ITERM_SESSION_ID) req.itermSessionId = process.env.ITERM_SESSION_ID;
      if (process.env.TMUX_PANE) req.tmuxPane = process.env.TMUX_PANE;
      sock.write(JSON.stringify(req) + "\n");
    });
    sock.on("data", (chunk) => {
      buffer += chunk.toString();
      const nl = buffer.indexOf("\n");
      if (nl === -1) return;
      try {
        finish(JSON.parse(buffer.slice(0, nl)));
      } catch {
        finish({ ok: false, error: "parse" });
      }
    });
    sock.on("error", () => finish({ ok: false, error: "socket" }));
    sock.on("end", () => finish({ ok: false, error: "closed" }));
    timer = setTimeout(() => finish({ ok: false, error: "timeout" }), IPC_TIMEOUT_MS);
  });
}

/** Deliver text (or voice) to PAILot via the existing pailot_send IPC. */
export function pailotDeliver(text, voice) {
  return ipcCall("pailot_send", { text, voice: !!voice });
}

// ── per-turn dedupe markers ───────────────────────────────────────────────

export function hashPrompt(text) {
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

/**
 * Returns true the FIRST time it is called for a given (kind, sessionId, hash)
 * and false thereafter — so a hook fires at most once per turn.
 */
export function claimOnce(kind, sessionId, hash) {
  try {
    const marker = join(tmpdir(), `aibroker-${kind}-${sessionId || "x"}-${hash}.done`);
    if (existsSync(marker)) return false;
    writeFileSync(marker, String(Date.now()));
    return true;
  } catch {
    // If the marker can't be written, allow the action rather than suppress it.
    return true;
  }
}
