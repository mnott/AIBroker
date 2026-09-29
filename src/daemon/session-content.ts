/**
 * daemon/session-content.ts — Read terminal content from iTerm2 / tmux sessions.
 *
 * Uses JXA (iTerm2) or capture-pane (tmux) to read visible + scrollback content.
 * Also detects busy/idle state via `is at shell prompt`.
 *
 * Part of Session Orchestration (Phase 1, v0.7).
 */

import { _internal, withSessionJxa } from "../adapters/iterm/core.js";
import { snapshotAllSessions, routeToTmux, captureSession, isClaudeRunningInSession } from "../transport/sync-facade.js";
import { getAllPersistentSessionNames, lookupPersistentName } from "../core/persistence.js";
import { log } from "../core/log.js";
import { timeCall } from "../core/call-timing.js";

export interface SessionContent {
  sessionId: string;
  name: string;
  content: string;
  lineCount: number;
  atPrompt: boolean;
  paiName: string | null;
}

/**
 * Short-TTL memo, keyed by session, storing the largest `lines` window fetched
 * recently. manage.ts's tick reads the same session's pane up to 4x per tick
 * (hash/change detection, then arm()'s pre-type checks) — same osascript
 * spawn, back to back, for content that has not had a chance to change.
 * Mirrors adapters/iterm/core.ts's SNAPSHOT_TTL_MS memo, same 3s and same
 * reasoning. A request for MORE lines than is cached still fetches fresh —
 * this only collapses redundant re-reads, never truncates a caller's answer.
 *
 * `fresh: true` (manage.ts's post-keystroke read-backs) always bypasses it:
 * those exist specifically to see what changed since the write that just
 * happened, and a cached pre-write answer there would be silently wrong.
 */
const CONTENT_TTL_MS = 3_000;
const MIN_CACHE_LINES = 100;
const cache = new Map<string, { at: number; lines: number; result: SessionContent | null }>();

function sliceToLines(content: SessionContent, lines: number): SessionContent {
  const trimmed = content.content.split("\n").slice(-lines).join("\n");
  return { ...content, content: trimmed, lineCount: trimmed ? trimmed.split("\n").length : 0 };
}

/**
 * Read terminal content from a specific iTerm2 session.
 * Returns the last N lines of terminal output + busy/idle flag.
 */
export function readSessionContent(
  sessionId: string,
  lines = 100,
  opts: { fresh?: boolean } = {},
): SessionContent | null {
  if (!opts.fresh) {
    const cached = cache.get(sessionId);
    if (cached && Date.now() - cached.at < CONTENT_TTL_MS && cached.lines >= lines) {
      return cached.result ? sliceToLines(cached.result, lines) : null;
    }
  }

  const fetchLines = Math.max(lines, MIN_CACHE_LINES);
  const result = readSessionContentUncached(sessionId, fetchLines);
  cache.set(sessionId, { at: Date.now(), lines: fetchLines, result });
  return result ? sliceToLines(result, lines) : null;
}

/** tmux path: `capture-pane -p -J -S -<lines>` through the transport, no AppleScript. */
function readTmuxContent(sessionId: string, lines: number): SessionContent | null {
  const raw = timeCall("session-content:read", () => captureSession(sessionId, lines));
  if (raw === null) return null;
  // capture-pane pads the visible area with blank rows; they are not content.
  const content = raw.replace(/\s+$/, "");
  const snap = snapshotAllSessions().find((s) => s.id === sessionId);
  return {
    sessionId,
    name: snap?.name ?? sessionId,
    content,
    lineCount: content ? content.split("\n").length : 0,
    atPrompt: snap ? snap.atPrompt : !isClaudeRunningInSession(sessionId),
    paiName: lookupPersistentName(getAllPersistentSessionNames(), sessionId, snap?.aibrokerId),
  };
}

function readSessionContentUncached(sessionId: string, lines: number): SessionContent | null {
  if (routeToTmux(sessionId)) return readTmuxContent(sessionId, lines);

  // JXA: get contents, name, atPrompt for a specific session
  const script = withSessionJxa(
    sessionId,
    `          var content = aSession.contents();
          var paiName = "";
          try { paiName = aSession.variable({ named: "user.paiName" }) || ""; } catch (e) {}
          var allLines = content.split("\\n");
          var lastLines = allLines.length > ${lines} ? allLines.slice(allLines.length - ${lines}) : allLines;
          return [aSession.name(), String(aSession.isAtShellPrompt()), paiName, lastLines.join("\\n")].join("\\t");`,
    '"NOT_FOUND"',
  );

  // _internal indirection, as in core.ts's own enumeration, so tests can
  // replace the osascript call without mocking node:child_process.
  const result = timeCall("session-content:read", () => _internal.runItermJxa(script));
  if (!result || result === "NOT_FOUND") return null;

  const tabIdx = result.indexOf("\t");
  const tabIdx2 = result.indexOf("\t", tabIdx + 1);
  const tabIdx3 = result.indexOf("\t", tabIdx2 + 1);
  if (tabIdx < 0 || tabIdx2 < 0 || tabIdx3 < 0) return null;

  const name = result.substring(0, tabIdx);
  const atPrompt = result.substring(tabIdx + 1, tabIdx2) === "true";
  const paiName = result.substring(tabIdx2 + 1, tabIdx3);
  const content = result.substring(tabIdx3 + 1);

  return {
    sessionId,
    name,
    content,
    lineCount: content.split("\n").length,
    atPrompt,
    paiName: paiName && paiName !== "missing value" && paiName !== "" ? paiName : null,
  };
}

/**
 * Read terminal content from ALL iTerm2 sessions.
 * Returns array of session contents with busy/idle flags.
 */
export function readAllSessionContent(lines = 100): SessionContent[] {
  // First get all session IDs via snapshot
  const snapshots = snapshotAllSessions();
  if (snapshots.length === 0) return [];

  const results: SessionContent[] = [];
  for (const snap of snapshots) {
    const content = readSessionContent(snap.id, lines);
    if (content) {
      results.push(content);
    }
  }
  return results;
}
