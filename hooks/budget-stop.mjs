#!/usr/bin/env node
/**
 * budget-stop — refuse to start new work once the weekly budget passes a ceiling.
 *
 * The advisor whisper already tells a session to be frugal above 80%, and being
 * told to be frugal is not the same as stopping: every reminder still arrives
 * inside a turn that has already been paid for. This hook is the hard edge. It
 * runs on UserPromptSubmit, reads the same percentage the whisper reads, and
 * exits 2 when the ceiling is crossed — which is how a UserPromptSubmit hook
 * refuses a prompt outright, before a single token is spent on it.
 *
 * It is deliberately a SEPARATE hook rather than a branch inside the whisper:
 * the whisper composes advice and must always succeed, and a file that can stop
 * all work should be small enough to read in one sitting and removable without
 * touching anything that composes advice.
 *
 * Turning it off is a one-line edit of the config, by design — the operator
 * asked for a stop they could lift by saying so, not for a wall.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ADVISOR = join(homedir(), ".claude", "advisor-mode.json");
const CONFIG = join(homedir(), ".aibroker", "budget-stop.json");

/** Never throw out of a hook: a parse error must not become a stuck session. */
function readJson(path) {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
  } catch {
    return null;
  }
}

const cfg = readJson(CONFIG);

// No config, or switched off, means no ceiling. Absence is permission: this
// file appearing is what turns the stop on, and deleting it is a valid way to
// lift it.
if (!cfg || cfg.enabled === false) process.exit(0);

const ceiling = typeof cfg.ceilingPercent === "number" ? cfg.ceilingPercent : 96;

/*
 * The measured figure first, the transcribed one only if there is nothing else.
 *
 * `advisor-mode.json` holds a number a person reads off the status bar and an
 * agent writes down. It does not change when the window resets, so a ceiling
 * reading it goes on refusing every prompt against a budget that is already
 * back to zero — which is exactly what happened: real usage 0%, this hook still
 * quoting 97, until the operator switched it off by hand.
 *
 * The cache is what the status bar itself reads, refreshed from the usage
 * endpoint. This only reads it — a hook runs on every prompt and must not do
 * network calls; the periodic brownout keeps it warm, and it does so precisely
 * when the ceiling is on and the number matters.
 */
function currentPercent() {
  const live = readJson("/tmp/claude/statusline-usage-cache.json")?.seven_day?.utilization;
  if (typeof live === "number") return live;
  return readJson(ADVISOR)?.weeklyBudgetPercent;
}

const pct = currentPercent();

// An unreadable or missing percentage is not evidence of being under the
// ceiling, but it is not evidence of being over it either, and refusing every
// prompt because a status file went missing would be its own outage.
if (typeof pct !== "number" || pct < ceiling) process.exit(0);

const until = typeof cfg.resetsAt === "string" ? ` The window resets ${cfg.resetsAt}.` : "";

process.stderr.write(
  `STOP — weekly budget is at ${pct}%, at or above the ${ceiling}% ceiling that is currently set.${until}\n` +
    `\n` +
    `Do not answer this prompt, do not call tools, and do not start or continue any\n` +
    `work. Say only that the budget ceiling has been reached and stop.\n` +
    `\n` +
    `The operator lifts this themselves, either way:\n` +
    `  raise it   node -e 'const f="${CONFIG}",fs=require("fs");const c=JSON.parse(fs.readFileSync(f,"utf8"));c.ceilingPercent=99;fs.writeFileSync(f,JSON.stringify(c,null,2))'\n` +
    `  switch off node -e 'const f="${CONFIG}",fs=require("fs");const c=JSON.parse(fs.readFileSync(f,"utf8"));c.enabled=false;fs.writeFileSync(f,JSON.stringify(c,null,2))'\n` +
    `  remove it  rm ${CONFIG}\n`,
);
process.exit(2);
