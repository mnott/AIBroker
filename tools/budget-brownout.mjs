#!/usr/bin/env node
/**
 * budget-brownout — stand every working session down before the weekly budget
 * runs out, and stand the same ones back up once the window resets.
 *
 * The refusal hook is the hard edge: past the ceiling, no new prompt is
 * answered. That protects the budget and nothing else. A session stopped that
 * way stops mid-thought, with whatever it knew still only in its context, and
 * the context is the thing that does not survive the wait. So the ceiling needs
 * a second half — reached in ORDER: ask for a handover while answering is still
 * possible, then pause the arming so nothing starts again, and only then let
 * the refusal take over.
 *
 * Two rules shape the rest of it.
 *
 * Only sessions that are WORKING are stood down. A session sitting at a prompt
 * costs nothing and pausing it would be a stop the operator has to undo by
 * hand for no gain — and worse, it would be indistinguishable at resume time
 * from one that was interrupted, so the record of who to restart would be
 * wrong.
 *
 * Resume restarts exactly the set that was paused, and nobody else. The names
 * are written down at brownout, because by the time the window resets the only
 * evidence of who was mid-flight is that list.
 *
 * Run it from anything periodic — the manage watchdog already ticks. It is
 * idempotent: brownout happens once per crossing, resume once per window.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOME = homedir();
const ADVISOR = join(HOME, ".claude", "advisor-mode.json");
const CONFIG = join(HOME, ".aibroker", "budget-stop.json");
const STATE = join(HOME, ".aibroker", "budget-brownout.json");
const MANAGERS = join(HOME, ".aibroker", "managers.json");
const CLI = join(dirname(dirname(fileURLToPath(import.meta.url))), "dist", "daemon", "cli.js");

function readJson(path, fallback = null) {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback;
  } catch {
    return fallback;
  }
}

function log(line) {
  const t = new Date().toISOString().slice(0, 19).replace("T", " ");
  console.log(`[budget-brownout ${t}] ${line}`);
}

/** `manage <name> <verb>`, never fatal: one stuck session must not strand the rest. */
function manage(name, ...args) {
  try {
    return execFileSync("node", [CLI, "manage", name, ...args], {
      encoding: "utf8",
      timeout: 90_000,
      env: { ...process.env, ANTHROPIC_API_KEY: undefined },
    });
  } catch (err) {
    log(`manage ${name} ${args.join(" ")} failed: ${err.message.split("\n")[0]}`);
    return "";
  }
}

/** Recreate a session from its PAI project. Never fatal, same reasoning as manage(). */
function launch(name) {
  try {
    return execFileSync("node", [CLI, "launch", name], { encoding: "utf8", timeout: 120_000 });
  } catch (err) {
    log(`launch ${name} failed: ${err.message.split("\n")[0]}`);
    return "";
  }
}

/** Block without a timer: this runs in a watchdog tick, not an event loop. */
function sleep(seconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
}

/*
 * Working, as the manager itself reports it — not as this script guesses. The
 * status line is the same one a human reads, which means a change in how busy
 * is decided lands here for free instead of drifting apart from it.
 */
function isWorking(name) {
  return /^\s*working\b/m.test(manage(name, "status"));
}

const cfg = readJson(CONFIG);
if (!cfg || cfg.enabled === false) process.exit(0);

const ceiling = typeof cfg.ceilingPercent === "number" ? cfg.ceilingPercent : 96;
const pct = readJson(ADVISOR)?.weeklyBudgetPercent;
const state = readJson(STATE, null);
const now = Date.now();

/*
 * The reset moment is configured rather than derived. The status bar's own
 * figure has been wrong before — it read 05:59 while the plan page counted
 * down to 08:00 local — and a resume that fires two hours early spends the
 * budget it was built to protect.
 */
const resetAt = cfg.resetsAtIso ? Date.parse(cfg.resetsAtIso) : NaN;

// ---- stand back up ------------------------------------------------------
/*
 * Two conditions, not one. The clock says the window is ALLOWED to have
 * reopened; the percentage says it actually HAS. Trusting the clock alone puts
 * every session back to work into a budget that is still full, where the
 * refusal hook turns them away one prompt at a time — which looks like a
 * broken resume rather than a ceiling doing its job. Trusting the percentage
 * alone is worse: it drifts down over a long enough pause and would restart
 * everything hours early.
 *
 * The clock is therefore the earliest permitted moment and the reading is the
 * evidence. Missing the exact minute costs one tick and nothing else.
 */
if (state?.pausedNames?.length) {
  const due = Number.isFinite(resetAt) && now >= resetAt;
  const room = typeof pct === "number" && pct < ceiling;
  if (due && room) {
    for (const name of state.pausedNames) {
      /*
       * A pause survives a restart; a terminal does not. `managers.json` still
       * holds the objective and the paused flag, so resume alone would clear
       * the flag against a pane that no longer exists and report success while
       * nothing ran. Recreating the session first is what makes the recovery
       * real rather than bookkeeping.
       *
       * The test is whether the manager can still see it: status prints
       * nothing when the session cannot be resolved.
       */
      if (!manage(name, "status").trim()) {
        log(`${name} has no session — relaunching`);
        launch(name);
        // The pane has to exist before arming can type into it. Polling beats
        // a fixed sleep: a machine still busy after a restart takes longer,
        // and a fast one should not be made to wait for the slow case.
        for (let i = 0; i < 20 && !manage(name, "status").trim(); i++) sleep(3);
        // Slow is not the same as absent. Arming a pane that is not ready costs
        // a keystroke and the next tick retries; not arming one that was ready
        // leaves it idle holding its objective, which is the failure this is
        // here to prevent.
        if (!manage(name, "status").trim()) log(`${name} slow to appear — arming anyway`);
      }
      manage(name, "resume");
      // resume only permits arming again; the next tick would arm eventually,
      // but a session brought back from nothing has an empty screen and no
      // reason to do anything until it is told.
      manage(name, "now");
      log(`resumed ${name}`);
    }
    writeFileSync(STATE, JSON.stringify({ ...state, resumedAt: new Date().toISOString(), pausedNames: [] }, null, 2));
    log(`budget back to ${pct}% — resumed ${state.pausedNames.length} session(s)`);
  } else if (due) {
    // Worth a line: the window passed and the budget did not come back, which
    // is the case somebody has to look at rather than wait through.
    log(`reset time passed but budget still reads ${pct ?? "unknown"}% — holding`);
  }
  process.exit(0);
}

// ---- stand down ---------------------------------------------------------
if (typeof pct !== "number" || pct < ceiling) process.exit(0);

const managers = readJson(MANAGERS, {});
const names = Object.values(managers)
  .map((m) => m?.name)
  .filter(Boolean);

const paused = [];
for (const name of names) {
  if (!isWorking(name)) {
    log(`${name} is not working — left alone`);
    continue;
  }
  // Order matters: the handover has to be asked for while the session can
  // still answer, and the pause has to land before it picks anything else up.
  manage(
    name,
    "Weekly budget ceiling reached. Write your handover NOW — everything you know that is not " +
      "already in the tracker or a file — then stop and do not start another item. Work resumes " +
      "automatically when the window resets.",
  );
  manage(name, "handover");
  manage(name, "pause");
  paused.push(name);
  log(`stood down ${name}`);
}

writeFileSync(
  STATE,
  JSON.stringify(
    {
      pausedAt: new Date().toISOString(),
      atPercent: pct,
      ceiling,
      resumeAfter: cfg.resetsAtIso ?? null,
      pausedNames: paused,
    },
    null,
    2,
  ),
);
log(`brownout at ${pct}% — ${paused.length} of ${names.length} managed session(s) stood down`);
