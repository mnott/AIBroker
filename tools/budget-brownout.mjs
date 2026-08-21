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
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

/** When a file was last written, or null. Freshness is the only use. */
function statMtime(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function log(line) {
  const t = new Date().toISOString().slice(0, 19).replace("T", " ");
  console.log(`[budget-brownout ${t}] ${line}`);
}

/** `manage <name> <verb>`, never fatal: one stuck session must not strand the rest. */
function manage(name, ...args) {
  try {
    return execFileSync(process.execPath, [CLI, "manage", name, ...args], {
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
    return execFileSync(process.execPath, [CLI, "launch", name], { encoding: "utf8", timeout: 120_000 });
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
const now = Date.now();

/**
 * The real figure, from the same endpoint the status bar uses.
 *
 * The alternative was a number someone reads off the screen and an agent
 * writes to a file, which is wrong twice over: it is only as current as the
 * last time a person looked, and after a stand-down nobody is left to look —
 * so the reading freezes at the ceiling and the resume that waits for it waits
 * for ever.
 *
 * Refreshing here rather than only reading is the point. This runs on a timer
 * that does not care whether any session is alive, which is exactly the
 * condition under which the number has to keep moving.
 */
function readUsage() {
  const cache = "/tmp/claude/statusline-usage-cache.json";
  const age = statMtime(cache);
  if (age === null || now - age > 10 * 60_000) {
    try {
      const token = JSON.parse(
        execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], {
          encoding: "utf8",
          timeout: 10_000,
        }),
      )?.claudeAiOauth?.accessToken;
      if (token) {
        const body = execFileSync(
          "curl",
          ["-sf", "--max-time", "10", "-H", `Authorization: Bearer ${token}`,
           "-H", "anthropic-beta: oauth-2025-04-20", "https://api.anthropic.com/api/oauth/usage"],
          { encoding: "utf8", timeout: 15_000 },
        );
        if (body.trim()) {
          mkdirSync("/tmp/claude", { recursive: true });
          writeFileSync(cache, body);
        }
      }
    } catch {
      // A refresh that fails leaves whatever was cached, which is still better
      // evidence than a hand-typed number. Never fatal.
    }
  }
  const j = readJson(cache, null);
  const pct = j?.seven_day?.utilization;
  const resets = j?.seven_day?.resets_at ? Date.parse(j.seven_day.resets_at) : NaN;
  // `live` is what the caller needs to know: a measured figure can be trusted
  // on its own, the hand-written fallback cannot.
  if (typeof pct === "number") return { pct, resets, live: true };
  return { pct: readJson(ADVISOR)?.weeklyBudgetPercent, resets: NaN, live: false };
}

const usage = readUsage();
const pct = usage.pct;
const state = readJson(STATE, null);

/*
 * The endpoint states the reset moment, so prefer it and keep the configured
 * value as a fallback. The status BAR disagreed with the plan page — it showed
 * 05:59 against a countdown to 08:00 local — but that turned out to be the bar
 * rendering a UTC timestamp as if it were local, not a disagreement about the
 * facts. The underlying value was right all along, which is the argument for
 * reading it rather than transcribing what the screen says.
 */
const resetAt = Number.isFinite(usage.resets) ? usage.resets : cfg.resetsAtIso ? Date.parse(cfg.resetsAtIso) : NaN;

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

  /*
   * A measured figure gets a vote; a guessed one does not.
   *
   * When the endpoint answers, the percentage is current no matter how long
   * everything has been paused, so it can veto a resume the clock would allow.
   * When it does not answer, the only figure left is the one somebody typed
   * after reading the screen — and after a stand-down nobody is left to read
   * anything, so it is frozen at the ceiling by construction. Requiring it
   * would mean waiting for a number that cannot change, for ever. In that case
   * the reset time decides alone.
   */
  const room = !usage.live || (typeof pct === "number" && pct < ceiling);
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
  /*
   * Clearing the goal is what actually stops the work, and it took a live
   * failure to see why. `pause` stops the MANAGER from arming; it says nothing
   * to the session, which is running its own goal loop and feeding itself. That
   * loop never passes through the prompt hook either, so the refusal cannot
   * reach it. A session under a goal therefore sails straight through a ceiling
   * that has stopped everything else.
   *
   * So: clear the goal in the session, then pause the manager. Both are needed
   * and neither substitutes for the other — clearing alone would let the next
   * arming start it again, pausing alone leaves the loop running.
   *
   * Arming re-establishes the goal, so resume needs no counterpart to this.
   */
  manage(name, "/goal clear");
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
