#!/usr/bin/env node
/**
 * hooks/handover-due.mjs — deliver the manager's "write your handover" ask
 * without typing into the terminal.
 *
 * A goal-driven session is almost never idle, and the typed ask is gated on
 * idleness, so it never fired and the session compacted with no handover. The
 * manager now writes a per-session marker when a band is due
 * (~/.aibroker/handover-due/<session key>.json); this PostToolUse /
 * UserPromptSubmit hook reads the marker for its OWN session and returns it
 * once as additionalContext, then deletes it. Nothing there: silent.
 *
 * Silent on every error: a hook that fails loudly on every tool call is a hook
 * someone disables.
 */

import { readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// A worker child inherits its owner's pane ids; it must never consume the owner's ask.
if (process.env.PAI_WORKER === "1") process.exit(0);

const DIR = process.env.AIBROKER_HANDOVER_DIR ?? join(homedir(), ".aibroker", "handover-due");

const raw = process.env.TMUX_PANE ?? process.env.ITERM_SESSION_ID;
if (!raw) process.exit(0);
const id = raw.includes(":") ? raw.split(":").pop() : raw;
const file = join(DIR, `${id.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);

let marker;
try {
  marker = JSON.parse(readFileSync(file, "utf8"));
} catch {
  process.exit(0); // no marker: nothing to say
}

let event = "PostToolUse";
try {
  let buf = "";
  if (!process.stdin.isTTY) {
    const read = (async () => { for await (const c of process.stdin) buf += c; })();
    await Promise.race([read, new Promise((r) => setTimeout(r, 300))]);
  }
  const name = JSON.parse(buf)?.hook_event_name;
  if (name === "UserPromptSubmit" || name === "PostToolUse") event = name;
} catch { /* payload unreadable: default event */ }

const text =
  `Context at ${marker.contextK}k of ~${marker.triggerK}k: update your handover now (${marker.target}) ` +
  `for your future self: where it stands, running work with ids, next steps, things written nowhere else. ` +
  `Then continue.`;

// Consume first: a duplicate ask is worse than a lost one (the manager re-asks on its own clock).
try { unlinkSync(file); } catch { process.exit(0); }

process.stdout.write(
  JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }) + "\n",
);
