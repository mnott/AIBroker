/**
 * transport/screen.ts — pure predicates over a captured terminal frame.
 *
 * Deliberately dependency-free so the transport layer itself can use them
 * without importing anything that imports the transport back.
 */

/** The line Claude's input box is drawn on. */
export const INPUT_LINE = /^\s*❯/;
/** A horizontal rule; the input box is bounded by two of them. */
export const CLAUDE_UI = /─{20,}/;
/** A shell prompt: a line ending in a common prompt terminator. */
export const SHELL_PROMPT = /[➜$%#»]\s*$/;

/** Collapse whitespace so wrapped and padded terminal text compares sanely. */
export function flatten(s: string): string { return s.replace(/\s+/g, " ").trim(); }

/**
 * True when Claude's input box is LIVE at the bottom of the screen.
 *
 * "Contains a box somewhere" is not enough, and the difference is a safety
 * issue. When Claude exits — crashes, is suspended, or is ended cleanly — its
 * whole UI stays in the terminal's scrollback while a shell prompt appears
 * underneath. A frame-wide search still finds the rules and the `❯`, declares
 * the session ready, and the caller types into a live shell, where zsh
 * EXECUTES the text.
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
 * because the `❯` marker also matches every echoed message in the transcript.
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
