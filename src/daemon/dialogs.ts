/**
 * daemon/dialogs.ts — the modal nobody is there to click.
 *
 * WHY THIS EXISTS. Everything else that watches a managed session watches its
 * TERMINAL: the pane's text, the transcript, the manager's own history. A macOS
 * modal belongs to a different process and appears in none of them, so a
 * session can sit blocked behind one for hours while every signal reads
 * healthy — working, goal armed, screen unchanged for a plausible reason. An
 * operator discovered this the only way it can be discovered without this file:
 * by finding the dialog by hand and clicking it a hundred times.
 *
 * WHAT IT WILL AND WILL NOT PRESS. Only prompts of the "may this app do the
 * obvious thing it was just asked to do" kind, from a fixed list of system
 * agents, with a fixed list of button titles. Anything asking for a credential
 * is excluded by name and by construction: SecurityAgent is not on the list,
 * and no button title here is one that a password sheet offers. The rule is
 * that this may only re-consent to something the operator already set in
 * motion; it may never grant something new.
 */

import { runAppleScript } from "../adapters/iterm/core.js";
import { log } from "../core/log.js";

/**
 * The agents allowed to have their dialogs answered.
 *
 * Short and closed on purpose. Each is a system process whose entire job is
 * asking permission for an action a user already initiated — opening an app
 * that was just built, letting one app drive another that it has been driving
 * all evening. SecurityAgent is deliberately ABSENT: that is the one that asks
 * for passwords and disk access, and nothing should ever answer it but a
 * person.
 */
const ANSWERABLE = ["CoreServicesUIAgent", "UserNotificationCenter"];

/**
 * Buttons that mean "yes, as already intended".
 *
 * Matched exactly, never as a substring — "Don't Allow" contains "Allow", and a
 * substring match would turn a refusal into consent. Order matters: the first
 * title found on the dialog is the one pressed.
 */
const SAFE_BUTTONS = ["Open", "Allow", "OK"];

/** A dialog seen on screen, flattened to the few facts worth acting on. */
export interface SeenDialog {
  process: string;
  title: string;
  buttons: string[];
}

const LIST_SCRIPT = `
tell application "System Events"
  set out to ""
  repeat with pname in {${ANSWERABLE.map((p) => `"${p}"`).join(", ")}}
    try
      tell process pname
        repeat with w in windows
          set btns to ""
          try
            repeat with b in buttons of w
              set btns to btns & (title of b) & "~"
            end repeat
          end try
          set out to out & (pname as string) & "|" & (name of w) & "|" & btns & linefeed
        end repeat
      end tell
    end try
  end repeat
  return out
end tell`;

/** Every dialog currently on screen that belongs to an answerable agent. */
export function listDialogs(): SeenDialog[] {
  const raw = runAppleScript(LIST_SCRIPT, 10_000);
  if (!raw) return [];
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [process, title, btns] = line.split("|");
      return {
        process: process ?? "",
        title: title ?? "",
        buttons: (btns ?? "").split("~").map((b) => b.trim()).filter(Boolean),
      };
    })
    .filter((d) => ANSWERABLE.includes(d.process));
}

/**
 * Answer one dialog, and say which button was pressed.
 *
 * Returns null when nothing was pressed, which includes the case of a dialog
 * offering none of the safe titles — an unrecognised prompt is left alone and
 * reported rather than guessed at, because the whole value of a closed list is
 * lost the moment something falls back to "press the default".
 */
export function answerDialog(d: SeenDialog): string | null {
  const button = SAFE_BUTTONS.find((b) => d.buttons.includes(b));
  if (!button) return null;
  const script = `tell application "System Events" to tell process "${d.process}" to click button "${button}" of window 1`;
  const ok = runAppleScript(script, 10_000);
  if (ok === null) {
    log(`[dialogs] could not press "${button}" on ${d.process}`);
    return null;
  }
  return button;
}
