/**
 * daemon/budget-cli.ts — `aibroker budget`, the lever on the spending ceiling.
 *
 * The ceiling itself is two small pieces: a UserPromptSubmit hook that refuses
 * new prompts once the weekly percentage crosses a line, and a periodic script
 * that stands working sessions down with a handover first and back up when the
 * window resets. Both read one JSON file, and this command is how a person
 * edits that file without having to remember where it lives or what shape it
 * is.
 *
 * It exists because of WHO has to use it and WHEN. The moment the ceiling
 * bites, the sessions that could have edited a config are exactly the ones
 * being refused, so the lever has to work from a bare shell, in one line, from
 * any directory — and it has to be findable by someone who last thought about
 * this a week ago. `aibroker budget off` is that; a node -e incantation with a
 * quoted path in it is not.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FILE = join(homedir(), ".aibroker", "budget-stop.json");

interface BudgetConfig {
  enabled?: boolean;
  ceilingPercent?: number;
  /**
   * A lower line that stops only MANAGED sessions. Unattended overnight work is
   * what can spend the week; the operator's own sessions keep answering past
   * it. Independent of `enabled`, which belongs to the wall above.
   */
  managedCeilingPercent?: number | null;
  resetsAtIso?: string | null;
  note?: string;
}

function read(): BudgetConfig {
  try {
    return existsSync(FILE) ? (JSON.parse(readFileSync(FILE, "utf8")) as BudgetConfig) : {};
  } catch {
    return {};
  }
}

function write(cfg: BudgetConfig): void {
  mkdirSync(join(homedir(), ".aibroker"), { recursive: true });
  writeFileSync(FILE, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

function percent(): number | null {
  try {
    const p = join(homedir(), ".claude", "advisor-mode.json");
    const v = JSON.parse(readFileSync(p, "utf8")).weeklyBudgetPercent;
    return typeof v === "number" ? v : null;
  } catch {
    return null;
  }
}

function show(): void {
  const cfg = read();
  const pct = percent();
  const on = cfg.enabled !== false && existsSync(FILE);
  console.log(`  ceiling   ${on ? `${cfg.ceilingPercent ?? 96}%` : "off — nothing stops"}`);
  console.log(
    `  managed   ${typeof cfg.managedCeilingPercent === "number" ? `${cfg.managedCeilingPercent}% — managed sessions only` : "off"}`,
  );
  console.log(`  now at    ${pct === null ? "unknown" : `${pct}%`}`);
  if (cfg.resetsAtIso) {
    const at = new Date(cfg.resetsAtIso);
    const mins = Math.round((at.getTime() - Date.now()) / 60_000);
    console.log(
      `  resets    ${at.toLocaleString()}${mins > 0 ? ` — in ${Math.floor(mins / 60)}h ${mins % 60}m` : " — passed"}`,
    );
  }
  if (cfg.note) console.log(`  note      ${cfg.note}`);
  console.log("");
  console.log("  Crossing the ceiling asks every WORKING managed session for a handover,");
  console.log("  pauses its arming, and refuses new prompts everywhere until the reset.");
  console.log("  Crossing the managed line does the same to managed sessions only;");
  console.log("  everything else keeps answering. Sessions sitting idle are left alone.");
}

/**
 * Act on the ceiling now rather than at the next tick.
 *
 * Switching a limit on and watching nothing happen for a quarter of an hour is
 * indistinguishable from a limit that does not work — which is exactly how this
 * looked the first time it was tried. The periodic run is what makes it
 * reliable; running it here is what makes it believable, and it is the same
 * script either way, so there is no second code path to keep honest.
 */
/**
 * Put back to work anything the ceiling stood down, and forget the record.
 *
 * `resume` alone lifts the pause without giving the session anything to do —
 * it sits at a prompt holding an objective nobody has handed it. `now` is what
 * makes the restart real, and it re-establishes the goal the stand-down cleared.
 */
function releasePaused(): void {
  const state = join(homedir(), ".aibroker", "budget-brownout.json");
  let names: string[] = [];
  try {
    names = (JSON.parse(readFileSync(state, "utf8")) as { pausedNames?: string[] }).pausedNames ?? [];
  } catch {
    return;
  }
  const cli = join(dirname(fileURLToPath(import.meta.url)), "cli.js");
  for (const name of names) {
    for (const verb of ["resume", "now"]) {
      try {
        execFileSync(process.execPath, [cli, "manage", name, verb], { encoding: "utf8", timeout: 90_000 });
      } catch {
        console.error(`  could not ${verb} ${name} — do it by hand`);
      }
    }
    console.log(`  ${name} released and armed.`);
  }
  try {
    writeFileSync(state, JSON.stringify({ releasedAt: new Date().toISOString(), pausedNames: [] }, null, 2));
  } catch {
    /* the record is a convenience; the sessions are what matter */
  }
}

function checkNow(): void {
  const script = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tools", "budget-brownout.mjs");
  try {
    const out = execFileSync(process.execPath, [script], { encoding: "utf8", timeout: 300_000 }).trim();
    console.log(out ? out : "  nothing to do at the moment.");
  } catch (err) {
    console.error(`  the check itself failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  }
}

export async function runBudget(args: string[]): Promise<void> {
  const [action, value] = args;
  const cfg = read();

  if (!action || action === "status") {
    show();
    return;
  }

  if (action === "off" || action === "ignore") {
    /*
     * Release before switching off, in that order.
     *
     * Off means "stop protecting the budget", never "leave whatever you already
     * stopped stopped". The periodic script exits immediately when the ceiling
     * is disabled, so anything it had paused would sit paused for good — the
     * operator lifts the limit, watches nothing come back, and reasonably
     * concludes the whole mechanism is broken. Doing it here rather than there
     * is deliberate: this is the moment the intention is expressed.
     */
    releasePaused();
    write({ ...cfg, enabled: false });
    console.log("Ceiling off. Nothing will be stopped, whatever the percentage says.");
    console.log("Back on with: aibroker budget on");
    return;
  }

  if (action === "on") {
    write({ ...cfg, enabled: true, ceilingPercent: cfg.ceilingPercent ?? 96 });
    console.log(`Ceiling on at ${cfg.ceilingPercent ?? 96}%. Checking now:`);
    checkNow();
    return;
  }

  if (action === "check") {
    checkNow();
    return;
  }

  if (action === "ceiling") {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0 || n > 100) {
      console.error("Usage: aibroker budget ceiling <1-100>");
      process.exit(1);
    }
    write({ ...cfg, enabled: true, ceilingPercent: n });
    console.log(`Ceiling set to ${n}%.`);
    return;
  }

  if (action === "managed") {
    if (value === "off" || value === "clear") {
      write({ ...cfg, managedCeilingPercent: null });
      console.log("Managed line off. Managed sessions now stop only at the ceiling.");
      return;
    }
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0 || n > 100) {
      console.error("Usage: aibroker budget managed <1-100|off>");
      process.exit(1);
    }
    write({ ...cfg, managedCeilingPercent: n });
    console.log(`Managed sessions stop at ${n}% of the weekly budget; everything else keeps going. Checking now:`);
    checkNow();
    return;
  }

  if (action === "resets") {
    if (!value) {
      console.error('Usage: aibroker budget resets "2026-01-31T08:00"   (local time, or "clear")');
      process.exit(1);
    }
    if (value === "clear") {
      write({ ...cfg, resetsAtIso: null });
      console.log("Reset time cleared — paused sessions will need resuming by hand.");
      return;
    }
    const at = new Date(value);
    if (Number.isNaN(at.getTime())) {
      console.error(`Not a time I can read: ${value}`);
      process.exit(1);
    }
    write({ ...cfg, resetsAtIso: at.toISOString() });
    console.log(`Resume after ${at.toLocaleString()}.`);
    return;
  }

  console.log("Usage: aibroker budget [status|on|off|ceiling <n>|managed <n|off>|resets <time>]");
  console.log("");
  console.log("  off            ignore the limit entirely — the escape hatch");
  console.log("  on             put the ceiling back");
  console.log("  ceiling <n>    stop EVERYTHING at n% of the weekly budget");
  console.log("  managed <n>    stand MANAGED sessions down at n%, leave the rest running");
  console.log('  resets <time>  when the window reopens, e.g. "2026-01-31T08:00"');
  if (action) process.exit(1);
}
