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
/**
 * A row of the background-agents panel Claude draws UNDER its status lines
 * while agents run: a "main" header, one `◯ <agent> <task> · <time> · <tokens>`
 * row per agent, an overflow count, and the navigation hint. Up to a dozen
 * lines, all Claude's own, all below the closing rule.
 */
export const AGENT_PANEL = /^\s*(❯\s*)?⏺\s+main\b|^\s*[◯●◉]\s+\S+\s{2,}|^\s*↓\s+\d+\s+more\b|↑\/↓ to select/;

/** Status-row furniture: box-drawing, the statusline glyphs, `·` separator runs. */
const STATUS_FURNITURE = /[─│├└💎🧠🐝✳◐·]/;

/**
 * A line below the closing rule that actually looks like a shell prompt: short,
 * bare of Claude's status furniture, and not part of the agents panel.
 *
 * The PAI statusline's usage row ends in a reset time (`7d: 1% → Sa. 08:00`)
 * except right after a window rolls, when there is no suffix yet and the row
 * ends bare `7d: 1%` — which SHELL_PROMPT matches perfectly. On 2026-09-27 both
 * 07:00 sweep sessions were read as "at a shell" for exactly that, their tasks
 * parked, and the day's runs silently never happened. Status rows are long and
 * full of furniture, so they are not prompts; only a short bare line is.
 */
function looksLikeShellPrompt(l: string): boolean {
  const bare = l.replace(/\s+/g, "");
  return bare.length <= 20 && !STATUS_FURNITURE.test(l) && !AGENT_PANEL.test(l);
}

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
  //
  // The background-agents panel is the exception: with agents running Claude
  // draws up to a dozen more rows under the status lines, and a session that
  // was plainly working was read as "at a shell" for exactly that reason —
  // the manager could not arm it and every send was refused (2026-09-03).
  // Those rows are Claude's, so they do not count against the box.
  const below = lines.slice(lastRule + 1).filter((l) => !AGENT_PANEL.test(l));
  if (below.length > 8) return false;

  // Belt and braces: an explicit prompt below the box means the shell has it —
  // but only a line that looks like a real prompt (see looksLikeShellPrompt),
  // and only when the shell visibly owns the bottom of the screen: the prompt
  // is the LAST non-empty line, with no live `❯` input row under the closing
  // rule. A frame that still shows Claude's `❯` input box below the rule is
  // Claude's own bottom, not a shell. (The agents panel's `❯ ⏺ main` header
  // matches INPUT_LINE too; it is panel, not an input box, so it is excluded.)
  const last = lines[lines.length - 1];
  const liveInputBelow = lines
    .slice(lastRule + 1)
    .some((l) => INPUT_LINE.test(l) && !AGENT_PANEL.test(l));
  if (!liveInputBelow && SHELL_PROMPT.test(last) && looksLikeShellPrompt(last)) {
    return false;
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

/**
 * Is the input box drawn and holding nothing?
 *
 * The distinction that matters for a freshly spawned session. `isClaudeReady`
 * asks whether the box EXISTS, which is the right question for "can this
 * session accept input at all" and the wrong one for "is it safe to type now":
 * a session launched with a queued `/Name …` preamble draws its box with
 * that preamble sitting inside it, unsubmitted. Typing a work order at that
 * moment appends to the queued text instead of replacing it — the dispatcher
 * and the preamble interleave, and so does anything the user types.
 *
 * Observed 2026-08-04: a spawned session received its Todoist work order while
 * `/Name Voice Notes` was still queued in the box.
 *
 * Emptiness — not idleness. A busy session with an empty box queues typed input
 * correctly and must still count as ready, which is what the original comment
 * on `waitForReady` was protecting and what waiting for the screen to settle
 * would have broken.
 */
export function isInputBoxEmpty(frame: string): boolean {
  return inputBoxLines(frame).every((l) => {
    const t = flatten(l).replace(/^[>❯]\s*/, "").trim();
    // The placeholder Claude renders in an empty box is not content.
    return t === "" || /^(try ")/i.test(t);
  });
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

/**
 * Claude Code marks its own idle state in the pane title: `✳ <name>` at rest,
 * a braille spinner glyph while working. tmux only knows the foreground
 * command (always `claude`/`node`), so the title is the idle signal there.
 */
export function isClaudeTitleIdle(title: string | null | undefined): boolean {
  return /^✳/.test(title ?? "");
}

/**
 * Is this frame Claude at rest? A live input box, nothing queued in it, and no
 * "esc to interrupt" hint in the last rows (Claude draws it only while working).
 */
export function isClaudeFrameIdle(frame: string): boolean {
  // "esc to interrupt" is drawn above the box (spinner row) or in Claude's own
  // footer row under it, so the tail is searched whole; a custom statusline
  // below the box does not affect the box lookup, which is structural.
  const tail = frame.split("\n").filter((l) => l.trim().length > 0).slice(-12).join("\n");
  return isClaudeReady(frame) && isInputBoxEmpty(frame) && !/esc to interrupt/i.test(tail);
}
