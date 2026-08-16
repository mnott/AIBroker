#!/usr/bin/env node
/**
 * manage-watchdog — the supervisor for the thing that supervises sessions.
 *
 * WHY THIS EXISTS AT ALL. The manager inside the daemon already notices a
 * session that has stopped moving and arms it. What it cannot notice is itself
 * having stopped: a tick loop that dies inside a living process leaves every
 * external signal healthy — launchd sees a running executable, the socket still
 * answers, the log simply goes quiet — while nothing is being managed. Every
 * check that runs INSIDE the thing being checked shares its failure modes, so
 * this runs outside, on its own schedule, owned by launchd.
 *
 * It is deliberately small and boring. It knows nothing about objectives,
 * rollovers, or what any session is for; it reads state written by others and
 * takes one of two crude actions — restart the daemon, or ask for an arming.
 * A watchdog with opinions is a second system to debug at three in the morning.
 *
 * It also names no session and hardcodes no path outside the user's own config
 * directory: whatever is under management is discovered from the state file, so
 * this works unchanged for one session or ten.
 */

import { readFileSync, appendFileSync, statSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const CONFIG_DIR = join(homedir(), ".aibroker");
const STATE_FILE = join(CONFIG_DIR, "managers.json");
const HEARTBEAT_FILE = join(CONFIG_DIR, "manage-heartbeat");
const LOG_FILE = join(CONFIG_DIR, "manage-watchdog.log");

/** The daemon CLI, found relative to this script so no absolute path is baked in. */
const CLI = join(dirname(dirname(fileURLToPath(import.meta.url))), "dist", "daemon", "cli.js");

/**
 * How stale a heartbeat has to be before the loop counts as stalled.
 *
 * The loop ticks every 20 seconds, so this is many missed ticks rather than
 * one: a single slow tick — a screen read waiting on a busy terminal — must
 * never be read as death, because the response is a restart and restarting a
 * healthy daemon interrupts every session it manages.
 */
const HEARTBEAT_STALE_MS = 3 * 60_000;

/**
 * How long a managed session may sit unchanged before this asks for an arming.
 *
 * Longer than the daemon's own threshold on purpose. The daemon should always
 * win the race — it has better information and acts sooner. This firing at all
 * means the in-daemon detector did not, which is itself worth seeing in the
 * log, so the gap between the two thresholds is diagnostic rather than wasted.
 */
const SESSION_STUCK_MS = 25 * 60_000;

const now = Date.now();

/**
 * Local time, matching the daemon log exactly.
 *
 * ISO would be shorter to write and wrong to read: this log's only real use is
 * being laid beside the daemon's during a review, and a UTC column next to a
 * local one turns every comparison into arithmetic performed by someone tired.
 */
const stamp = (() => {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
})();

const actions = [];

function record(line) {
  try {
    appendFileSync(LOG_FILE, `${stamp} ${line}\n`);
  } catch {
    /* the log is a convenience; losing a line must not stop the checks */
  }
}

/** Run the daemon CLI. Never throws — a failed probe IS the finding. */
function cli(args, timeoutMs = 20_000) {
  try {
    return { ok: true, out: execFileSync("node", [CLI, ...args], { timeout: timeoutMs, encoding: "utf8" }) };
  } catch (e) {
    return { ok: false, out: String(e?.message ?? e) };
  }
}

function restartDaemon(why) {
  actions.push(`RESTART: ${why}`);
  record(`RESTART daemon — ${why}`);
  try {
    // Through launchd rather than by spawning one directly: a hand-started
    // daemon is not the one launchd will keep alive, and starting a second is
    // worse than the stall being fixed — two managers arming one session race
    // over the same state file.
    execFileSync("launchctl", ["kickstart", "-k", `gui/${process.getuid()}/com.aibroker.daemon`], { timeout: 30_000 });
  } catch (e) {
    record(`RESTART FAILED — ${String(e?.message ?? e)}`);
  }
}

// ---------------------------------------------------------------- the checks

/**
 * 1. Is the manager loop turning?
 *
 * Asked first because every later check reads state that a stalled loop stops
 * refreshing — a stale heartbeat makes the session readings below meaningless
 * rather than merely worrying, and acting on them would be acting on a photo.
 */
let heartbeatAgeMs = null;
if (existsSync(HEARTBEAT_FILE)) {
  try {
    heartbeatAgeMs = now - statSync(HEARTBEAT_FILE).mtimeMs;
  } catch {
    heartbeatAgeMs = null;
  }
}

if (heartbeatAgeMs === null) {
  // No heartbeat at all: either the daemon has never run this build, or it died
  // before writing one. A probe distinguishes them without guessing.
  const probe = cli(["status"], 15_000);
  if (!probe.ok) restartDaemon("no heartbeat and the daemon did not answer a status probe");
  else record("no heartbeat file yet, but the daemon answers — nothing done");
} else if (heartbeatAgeMs > HEARTBEAT_STALE_MS) {
  restartDaemon(`heartbeat is ${Math.round(heartbeatAgeMs / 60_000)} min old — the manager loop has stalled`);
}

/**
 * 2. Is anything under management sitting still?
 *
 * Skipped entirely when the loop is stalled: the daemon was just restarted, its
 * own detector gets first refusal, and arming a session on top of a restart it
 * has not finished processing is how one fault becomes two.
 */
if (!actions.length && existsSync(STATE_FILE)) {
  let managed = {};
  try {
    managed = JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch (e) {
    record(`state file unreadable — ${String(e?.message ?? e)}`);
  }

  for (const m of Object.values(managed)) {
    if (!m || m.paused) continue;
    // Mid-rollover sessions are deliberately still: one has been asked to write
    // its handover and is doing exactly that. Arming it would interrupt the
    // writing this whole mechanism exists to protect.
    if (m.handoverAskedAt) continue;
    const stillFor = now - (m.lastChangeAt ?? now);
    if (stillFor > SESSION_STUCK_MS) {
      const mins = Math.round(stillFor / 60_000);
      actions.push(`ARM ${m.name}: still for ${mins} min`);
      record(`ARM ${m.name} — nothing has moved for ${mins} min and the daemon's own detector did not fire`);
      cli(["manage", m.name, "now"]);
    }
  }
}

// ------------------------------------------------------------------ the note

/**
 * A quiet run still writes a line.
 *
 * A watchdog that only speaks up when something is wrong cannot be told apart
 * from one that has stopped running, which is the failure it is least able to
 * report on. The log is therefore a record of every check, and the review after
 * a long unattended stretch reads it for the silences.
 */
if (!actions.length) {
  const age = heartbeatAgeMs === null ? "none" : `${Math.round(heartbeatAgeMs / 1000)}s`;
  record(`ok — heartbeat ${age}`);
}

// Anything acted on is worth a line on stdout too, which launchd captures.
if (actions.length) console.log(`${stamp} ${actions.join("; ")}`);
