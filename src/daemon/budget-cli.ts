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

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const FILE = join(homedir(), ".aibroker", "budget-stop.json");

interface BudgetConfig {
  enabled?: boolean;
  ceilingPercent?: number;
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
  console.log("  Sessions sitting idle are left alone.");
}

export async function runBudget(args: string[]): Promise<void> {
  const [action, value] = args;
  const cfg = read();

  if (!action || action === "status") {
    show();
    return;
  }

  if (action === "off" || action === "ignore") {
    write({ ...cfg, enabled: false });
    console.log("Ceiling off. Nothing will be stopped, whatever the percentage says.");
    console.log("Back on with: aibroker budget on");
    return;
  }

  if (action === "on") {
    write({ ...cfg, enabled: true, ceilingPercent: cfg.ceilingPercent ?? 96 });
    console.log(`Ceiling on at ${cfg.ceilingPercent ?? 96}%.`);
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

  console.log("Usage: aibroker budget [status|on|off|ceiling <n>|resets <time>]");
  console.log("");
  console.log("  off            ignore the limit entirely — the escape hatch");
  console.log("  on             put the ceiling back");
  console.log("  ceiling <n>    stop at n% of the weekly budget");
  console.log('  resets <time>  when the window reopens, e.g. "2026-01-31T08:00"');
  if (action) process.exit(1);
}
