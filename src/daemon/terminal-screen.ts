/**
 * daemon/terminal-screen.ts — reading a Claude Code session off its terminal.
 *
 * Shared by `dispatch` (did my message get submitted?) and `ask` (is this
 * session working, and did it answer?). Both are screen-scraping, so both live
 * or die on the same handful of details:
 *
 *   - Claude echoes a submitted message into the transcript using the SAME `❯`
 *     marker as its input box, so "a caret line contains my text" is true both
 *     before and after submitting. The box has to be found structurally.
 *   - A working session animates (streaming tokens, a ticking elapsed counter),
 *     an idle one is completely static. That difference is the only reliable
 *     busy signal: `is at shell prompt` is false for EVERY Claude session,
 *     idle ones included, because Claude is itself the running program.
 */

import { captureSession, typeIntoSession } from "../transport/sync-facade.js";

/** The line Claude's input box is drawn on. */
export const INPUT_LINE = /^\s*❯/;
/** A horizontal rule; the input box is bounded by two of them. */
export const CLAUDE_UI = /─{20,}/;

/** Collapse whitespace so wrapped and padded terminal text compares sanely. */
export function flatten(s: string): string { return s.replace(/\s+/g, " ").trim(); }

/** Terminal access, injectable so the screen heuristics can be tested on real frames. */
export interface TerminalIO {
  capture: (id: string) => string | null;
  send: (id: string, text: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const realIO: TerminalIO = {
  capture: (id) => captureSession(id, 80),
  send: (id, text) => { typeIntoSession(id, text); },
  sleep,
  now: () => Date.now(),
};

/** A shell prompt: the tail of a line ending in a common prompt terminator. */
const SHELL_PROMPT = /[➜$%#»]\s*$/;

/**
 * True when Claude's input box is LIVE at the bottom of the screen.
 *
 * "Contains a box somewhere" is not enough, and the difference is a safety
 * issue rather than a cosmetic one. When Claude exits — crashes, is suspended,
 * or is quit — its whole UI stays in the terminal's scrollback while a shell
 * prompt appears underneath. A frame-wide search still finds the rules and the
 * `❯`, declares the session ready, and the caller then types into a live shell,
 * where zsh EXECUTES the text. Observed: a probe question ran as a command
 * ("zsh: no matches found: ok?"). A dispatched task body is multi-line and full
 * of backticks, so the same path would run arbitrary fragments of it.
 *
 * A live box is therefore required to be at the bottom: the closing rule near
 * the end of the visible frame, with nothing shell-prompt-shaped after it.
 */
export function isClaudeReady(frame: string): boolean {
  const lines = frame.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return false;

  let lastRule = -1;
  lines.forEach((l, i) => { if (CLAUDE_UI.test(l)) lastRule = i; });
  if (lastRule < 0) return false;

  // Claude renders only its status lines below the box; a shell fills the rest
  // of the screen, pushing the box further and further up.
  if (lines.length - 1 - lastRule > 8) return false;

  // Belt and braces: an explicit prompt below the box means the shell has it.
  for (let i = lastRule + 1; i < lines.length; i++) {
    if (SHELL_PROMPT.test(lines[i])) return false;
  }

  return lines.some((l) => INPUT_LINE.test(l));
}

/**
 * The lines inside Claude's input box.
 *
 * Identified structurally — the region between the last two horizontal rules —
 * because the `❯` marker alone also matches every echoed message in the
 * transcript above it.
 */
export function inputBoxLines(frame: string): string[] {
  const lines = frame.split("\n");
  const rules: number[] = [];
  lines.forEach((l, i) => { if (CLAUDE_UI.test(l)) rules.push(i); });
  if (rules.length >= 2) {
    const [open, close] = [rules[rules.length - 2], rules[rules.length - 1]];
    return lines.slice(open + 1, close);
  }
  return lines.filter((l) => INPUT_LINE.test(l)); // no box drawn — best effort
}

/** Index of the line opening the bottom input box, or -1. */
export function inputBoxStart(frame: string): number {
  const lines = frame.split("\n");
  const rules: number[] = [];
  lines.forEach((l, i) => { if (CLAUDE_UI.test(l)) rules.push(i); });
  return rules.length >= 2 ? rules[rules.length - 2] : -1;
}

/**
 * Has `needle` left the input box and landed in the transcript?
 *
 * Presence on screen is not enough: unsubmitted text in the box is also
 * present. Submission is the moment it appears while the box no longer holds it.
 */
export function hasBeenSubmitted(frame: string, needle: string): boolean {
  const stillTyped = inputBoxLines(frame).some((l) => flatten(l).includes(needle.slice(0, 24)));
  return !stillTyped && flatten(frame).includes(needle);
}
