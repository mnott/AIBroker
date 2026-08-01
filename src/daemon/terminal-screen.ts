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

/** True when a frame shows Claude's input box drawn and ready to take text. */
export function isClaudeReady(frame: string): boolean {
  return CLAUDE_UI.test(frame) && frame.split("\n").some((l) => INPUT_LINE.test(l));
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
