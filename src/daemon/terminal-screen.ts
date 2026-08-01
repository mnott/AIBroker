/**
 * daemon/terminal-screen.ts — reading a Claude Code session off its terminal.
 *
 * The predicates live in transport/screen.ts (dependency-free, so the transport
 * layer can guard its own writes with them); this module adds the live wiring.
 * Shared by `dispatch` (did my message get submitted?) and `ask` (is this
 * session working, and did it answer?).
 */

import { captureSession, typeIntoSession } from "../transport/sync-facade.js";

export {
  INPUT_LINE,
  CLAUDE_UI,
  SHELL_PROMPT,
  flatten,
  isClaudeReady,
  inputBoxLines,
  inputBoxStart,
  hasBeenSubmitted,
} from "../transport/screen.js";

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
