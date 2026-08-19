/**
 * daemon/pointer-controls.ts — does the session still hold the screen?
 *
 * The pointer tool gates its actuating calls behind a grant the operator makes
 * ("your controls"). The grant is an IDLE window: it is refreshed by every
 * actuating call and lapses that long after the last one. That is the right
 * default for a person at the machine, and the wrong one for an unattended
 * shift — a session that spends two hours reading code and running tests has
 * done nothing wrong, and finds the screen taken away when it next needs it.
 *
 * What this module exists for, though, is worse than the lapse. A session that
 * believed its screen time was over announced it had handed the controls back
 * and stopped all visual work — while the grant on disk was still valid for
 * another two hours. Nothing revoked anything; the belief alone cost the night.
 * So the manager needs to be able to answer three questions on every tick:
 * whether a grant exists, who holds it, and for how long — and then to say the
 * answer to the session in as many words, because a session that is not told
 * will decide for itself.
 *
 * This reads and writes the tool's own state file rather than inventing a
 * second record of the same fact. Two places holding "who has the screen" is
 * exactly the split-brain the fleet design note argues against.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Where the pointer tool keeps its grant. Its format, not ours. */
export function controlsFile(home = homedir()): string {
  return join(home, ".local", "state", "clickr", "controls.json");
}

export interface Controls {
  /** What is written on disk. A lapsed grant still says "agent" here. */
  holder: "user" | "agent";
  /** When the current holder took it, ms. */
  since: number;
  /** When an agent grant runs out, ms. Absent for the operator. */
  until?: number;
  /** The idle window the grant was made with, minutes. */
  minutes?: number;
  note?: string;
  /** No file at all — the tool has never recorded a grant on this machine. */
  missing: boolean;
  /** An agent grant whose window has passed. The tool will refuse a click. */
  lapsed: boolean;
  /** What the tool will actually answer right now. */
  effective: "user" | "agent";
}

const OPERATOR_HOLDS: Omit<Controls, "missing"> = {
  holder: "user",
  since: 0,
  lapsed: false,
  effective: "user",
};

/**
 * Read the grant as it stands.
 *
 * Never throws: an unreadable or malformed file means the tool will refuse a
 * click, and "the operator holds it" is the safe reading of that. The one thing
 * this must NOT do is collapse a lapsed grant into a plain operator hold —
 * telling those apart is the whole point, because one is ours to renew and the
 * other is the operator having taken the screen back.
 */
export function readControls(path = controlsFile(), now = Date.now()): Controls {
  let raw: unknown;
  try {
    if (!existsSync(path)) return { ...OPERATOR_HOLDS, missing: true };
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { ...OPERATOR_HOLDS, missing: true };
  }

  const o = raw as Record<string, unknown>;
  if (!o || typeof o !== "object") return { ...OPERATOR_HOLDS, missing: false };
  const holder = o.holder === "agent" ? "agent" : "user";
  const since = typeof o.since === "string" ? Date.parse(o.since) : NaN;
  const until = typeof o.until === "string" ? Date.parse(o.until) : NaN;

  const c: Controls = {
    holder,
    since: Number.isFinite(since) ? since : 0,
    lapsed: false,
    effective: holder,
    missing: false,
  };
  if (Number.isFinite(until)) c.until = until;
  if (typeof o.minutes === "number") c.minutes = o.minutes;
  if (typeof o.note === "string") c.note = o.note;

  if (holder === "agent" && (!Number.isFinite(until) || until <= now)) {
    c.lapsed = true;
    c.effective = "user";
  }
  return c;
}

/**
 * Record a grant that runs until a stated moment.
 *
 * Written straight to the file rather than by typing the trigger phrase at the
 * session: typing only works when the session is sitting at a prompt, and the
 * moment a renewal matters most is the moment it is busy. The operator asked
 * for the grant to be held for the length of the shift they authorised, so
 * holding it is carrying out their instruction, not granting on their behalf.
 */
export function grantUntil(until: number, note: string, path = controlsFile(), now = Date.now()): Controls {
  const minutes = Math.max(1, Math.ceil((until - now) / 60_000));
  const state = {
    holder: "agent" as const,
    since: new Date(now).toISOString(),
    until: new Date(until).toISOString(),
    minutes,
    note,
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n", "utf8");
  return readControls(path, now);
}

/** Hand the screen back. Used when a shift ends, so a grant never outlives it. */
export function returnToOperator(note: string, path = controlsFile(), now = Date.now()): void {
  const state = { holder: "user" as const, since: new Date(now).toISOString(), note };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n", "utf8");
}

export type Verdict =
  /** Ours, with time on it. Nothing to do. */
  | { action: "hold"; why: string }
  /** Ours to renew: never recorded, lapsed, or running out sooner than the shift. */
  | { action: "renew"; why: string }
  /** The operator took the screen back mid-shift. Their machine, their call. */
  | { action: "stand-off"; why: string };

/**
 * A grant with less than this left is renewed rather than watched. Comfortably
 * longer than a tick, so the window never closes between two looks at it.
 */
export const RENEW_FLOOR_MS = 10 * 60_000;

/**
 * Decide what the manager should do about the screen for a shift.
 *
 * The discriminator between "lapsed" and "the operator took it back" is which
 * holder is written on disk: a lapse leaves an agent grant with a past expiry
 * (nothing rewrites it), while the operator taking it back writes an operator
 * hold with a fresh timestamp. So an operator hold that started AFTER the shift
 * did is a deliberate act and is left alone; anything older is the state a
 * shift is expected to overwrite.
 */
export function verdict(
  c: Controls,
  shiftStartedAt: number,
  shiftUntil: number,
  now = Date.now(),
  floorMs = RENEW_FLOOR_MS,
): Verdict {
  if (c.holder === "user" && !c.missing && c.since > shiftStartedAt) {
    return { action: "stand-off", why: "the operator took the screen back after the shift began" };
  }
  if (c.missing) return { action: "renew", why: "no grant has ever been recorded on this machine" };
  if (c.holder === "user") return { action: "renew", why: "no grant was in place when the shift began" };
  if (c.lapsed) return { action: "renew", why: "the grant lapsed on its idle window" };
  if ((c.until ?? 0) < Math.min(shiftUntil, now + floorMs)) {
    return { action: "renew", why: "the grant runs out before the shift does" };
  }
  return { action: "hold", why: "the grant covers the rest of the shift" };
}

function clock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function span(ms: number): string {
  if (ms <= 0) return "0m";
  const mins = Math.round(ms / 60_000);
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/** One line for the status report: who has the screen, and for how much longer. */
export function describeControls(c: Controls, now = Date.now()): string {
  if (c.missing) return "screen: no grant recorded — pointer work would be refused";
  if (c.effective === "agent") {
    return `screen: the session holds it until ${clock(c.until!)} (${span(c.until! - now)} left)`;
  }
  if (c.lapsed) {
    return `screen: lapsed at ${clock(c.until ?? c.since)} — pointer work is being refused`;
  }
  return `screen: the operator holds it (since ${clock(c.since)})`;
}

/**
 * What to tell the session, in the goal, when it holds the screen.
 *
 * Positive and with a time on it, because the failure this answers was a
 * session inventing an expiry and standing down two hours early. Silence in the
 * goal about the screen reads, to a session that has been careful about the
 * operator's machine all night, as permission having quietly ended.
 */
export function screenGrantedClause(until: number): string {
  return (
    ` YOU HAVE THE SCREEN until ${clock(until)} — the grant is recorded and renewed for you, so do not hand the controls back,` +
    ` do not announce handing them back, and do not stand down from visual work before then.` +
    ` If a pointer call is ever refused, say so in one line and carry on with what does not need the screen.`
  );
}
