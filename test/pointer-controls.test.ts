/**
 * Does the session still hold the screen, and whose decision was it?
 *
 * The case worth having tests for is the one that cost a night's work: a grant
 * that has lapsed on its idle window looks, to anything that only asks "who
 * holds it", exactly like the operator having taken the screen back. One of
 * those is ours to renew and the other must be left alone, and the difference
 * is invisible unless something reads the file the way these tests do.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readControls,
  grantUntil,
  returnToOperator,
  verdict,
  describeControls,
  screenGrantedClause,
  controlsFile,
  RENEW_FLOOR_MS,
} from "../src/daemon/pointer-controls.js";

const NOW = Date.parse("2026-08-19T09:00:00.000Z");
const HOUR = 3_600_000;

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "controls-"));
  return join(dir, "state", "controls.json");
}

function write(path: string, body: unknown): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body), "utf8");
  return path;
}

test("controlsFile sits under the state directory, not the home root", () => {
  const p = controlsFile("/home/example");
  assert.equal(p, "/home/example/.local/state/clickr/controls.json");
});

test("a missing file reads as the operator holding it, and says so", () => {
  const c = readControls(join(tmpdir(), "definitely-not-here", "controls.json"), NOW);
  assert.equal(c.missing, true);
  assert.equal(c.effective, "user");
  assert.equal(c.lapsed, false);
});

test("unreadable rubbish never throws and never claims the screen", () => {
  const p = write(scratch(), "{ not json at all");
  const c = readControls(p, NOW);
  assert.equal(c.effective, "user");
  assert.equal(c.missing, true);
});

test("a live grant reads as held, with its expiry intact", () => {
  const p = write(scratch(), {
    holder: "agent",
    since: new Date(NOW - HOUR).toISOString(),
    until: new Date(NOW + 2 * HOUR).toISOString(),
    minutes: 240,
  });
  const c = readControls(p, NOW);
  assert.equal(c.effective, "agent");
  assert.equal(c.lapsed, false);
  assert.equal(c.until, NOW + 2 * HOUR);
});

test("a lapsed grant is refused in effect but still reads as ours on disk", () => {
  // This distinction is the point of the module: the holder on disk is what
  // says whose decision the current state was.
  const p = write(scratch(), {
    holder: "agent",
    since: new Date(NOW - 5 * HOUR).toISOString(),
    until: new Date(NOW - HOUR).toISOString(),
    minutes: 240,
  });
  const c = readControls(p, NOW);
  assert.equal(c.holder, "agent");
  assert.equal(c.lapsed, true);
  assert.equal(c.effective, "user");
});

test("an agent grant with no expiry at all has lapsed, not been granted forever", () => {
  const p = write(scratch(), { holder: "agent", since: new Date(NOW).toISOString() });
  const c = readControls(p, NOW);
  assert.equal(c.lapsed, true);
  assert.equal(c.effective, "user");
});

test("grantUntil writes the tool's own shape, and reads back as held", () => {
  const p = scratch();
  grantUntil(NOW + 4 * HOUR, "test", p, NOW);
  const raw = JSON.parse(readFileSync(p, "utf8"));
  assert.equal(raw.holder, "agent");
  assert.equal(raw.minutes, 240);
  assert.equal(Date.parse(raw.until), NOW + 4 * HOUR);
  assert.equal(readControls(p, NOW).effective, "agent");
});

test("grantUntil never writes a window shorter than a minute", () => {
  const p = scratch();
  grantUntil(NOW + 1_000, "test", p, NOW);
  assert.equal(JSON.parse(readFileSync(p, "utf8")).minutes, 1);
});

test("returnToOperator hands it back", () => {
  const p = scratch();
  grantUntil(NOW + HOUR, "test", p, NOW);
  returnToOperator("shift ended", p, NOW);
  const c = readControls(p, NOW);
  assert.equal(c.holder, "user");
  assert.equal(c.effective, "user");
});

// ---- the verdicts -------------------------------------------------------

const SHIFT_START = NOW - 3 * HOUR;
const SHIFT_END = NOW + 5 * HOUR;

test("a grant covering the rest of the shift is simply held", () => {
  const c = readControls(write(scratch(), {
    holder: "agent",
    since: new Date(SHIFT_START).toISOString(),
    until: new Date(SHIFT_END + HOUR).toISOString(),
  }), NOW);
  assert.equal(verdict(c, SHIFT_START, SHIFT_END, NOW).action, "hold");
});

test("a lapsed grant is renewed", () => {
  const c = readControls(write(scratch(), {
    holder: "agent",
    since: new Date(SHIFT_START).toISOString(),
    until: new Date(NOW - HOUR).toISOString(),
  }), NOW);
  assert.equal(verdict(c, SHIFT_START, SHIFT_END, NOW).action, "renew");
});

test("a grant about to run out is renewed before it can lapse between ticks", () => {
  const c = readControls(write(scratch(), {
    holder: "agent",
    since: new Date(SHIFT_START).toISOString(),
    until: new Date(NOW + RENEW_FLOOR_MS - 60_000).toISOString(),
  }), NOW);
  assert.equal(verdict(c, SHIFT_START, SHIFT_END, NOW).action, "renew");
});

test("no grant at all is renewed rather than reported as a refusal", () => {
  const c = readControls(join(tmpdir(), "nope", "controls.json"), NOW);
  assert.equal(verdict(c, SHIFT_START, SHIFT_END, NOW).action, "renew");
});

test("an operator hold from BEFORE the shift is the state a shift overwrites", () => {
  const c = readControls(write(scratch(), {
    holder: "user",
    since: new Date(SHIFT_START - HOUR).toISOString(),
  }), NOW);
  assert.equal(verdict(c, SHIFT_START, SHIFT_END, NOW).action, "renew");
});

test("an operator hold from DURING the shift is left alone — they took it back", () => {
  // The whole safety property. Renewing over this would be the manager taking
  // the pointer out of the operator's hands while they are using it.
  const c = readControls(write(scratch(), {
    holder: "user",
    since: new Date(NOW - 60_000).toISOString(),
  }), NOW);
  assert.equal(verdict(c, SHIFT_START, SHIFT_END, NOW).action, "stand-off");
});

// ---- what gets said -----------------------------------------------------

test("the status line names the expiry and how long is left", () => {
  const c = readControls(write(scratch(), {
    holder: "agent",
    since: new Date(SHIFT_START).toISOString(),
    until: new Date(NOW + 90 * 60_000).toISOString(),
  }), NOW);
  const line = describeControls(c, NOW);
  assert.match(line, /session holds it until \d\d:\d\d/);
  assert.match(line, /1h 30m left/);
});

test("a lapse is reported as a refusal, not as the operator holding it", () => {
  const c = readControls(write(scratch(), {
    holder: "agent",
    since: new Date(SHIFT_START).toISOString(),
    until: new Date(NOW - HOUR).toISOString(),
  }), NOW);
  assert.match(describeControls(c, NOW), /lapsed at \d\d:\d\d/);
});

test("the goal clause states an expiry and forbids handing the screen back", () => {
  // The failure being answered: a session announced it had handed the controls
  // back with two hours still on the grant. Nothing had revoked anything.
  const clause = screenGrantedClause(NOW + HOUR);
  assert.match(clause, /YOU HAVE THE SCREEN until \d\d:\d\d/);
  assert.match(clause, /do not hand the controls back/);
  assert.match(clause, /do not announce handing them back/);
});

test("cleanup", () => {
  // Nothing to assert; scratch dirs live under the OS temp dir and are cheap.
  rmSync(join(tmpdir(), "definitely-not-here"), { recursive: true, force: true });
});
