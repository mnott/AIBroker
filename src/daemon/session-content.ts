/**
 * daemon/session-content.ts — Read terminal content from iTerm2 sessions.
 *
 * Uses AppleScript to read the visible + scrollback content from iTerm2 tabs.
 * Also detects busy/idle state via `is at shell prompt`.
 *
 * Part of Session Orchestration (Phase 1, v0.7).
 */

import { runAppleScript, withSessionAppleScript, snapshotAllSessions } from "../adapters/iterm/core.js";
import { log } from "../core/log.js";

export interface SessionContent {
  sessionId: string;
  name: string;
  content: string;
  lineCount: number;
  atPrompt: boolean;
  paiName: string | null;
}

/**
 * Read terminal content from a specific iTerm2 session.
 * Returns the last N lines of terminal output + busy/idle flag.
 */
export function readSessionContent(sessionId: string, lines = 100): SessionContent | null {
  // AppleScript: get contents, name, atPrompt for a specific session
  const script = withSessionAppleScript(
    sessionId,
    `          set sessionName to name of aSession
          set isAtPrompt to (is at shell prompt of aSession)
          tell aSession
            try
              set paiName to (variable named "user.paiName")
            on error
              set paiName to ""
            end try
          end tell
          set rawContent to contents of aSession
          -- Take last N lines
          set AppleScript's text item delimiters to linefeed
          set allLines to text items of rawContent
          set lineCount to count of allLines
          if lineCount > ${lines} then
            set lastLines to items (lineCount - ${lines - 1}) thru lineCount of allLines
          else
            set lastLines to allLines
          end if
          set resultContent to lastLines as text
          return sessionName & (ASCII character 9) & (isAtPrompt as text) & (ASCII character 9) & paiName & (ASCII character 9) & resultContent`,
    'return "NOT_FOUND"',
  );

  const result = runAppleScript(script);
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
