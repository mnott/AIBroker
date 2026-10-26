import "./home-guard.js";
/**
 * test/pai-session-map.test.ts — "self", when the environment cannot say it.
 *
 * The fault this pins, observed live 2026-10-20 03:05: every session run under
 * the Claude background daemon was refused by arm-self and session=self with
 * "run this from inside your own session", because the daemon's children carry
 * no ITERM_SESSION_ID — and the overnight supervised sessions are daemon-run
 * by construction. PAI's statusline keeps the answer in
 * ~/.claude/pai/session-claude-map.json (claude session id → iTerm uid), and
 * daemon/pai-session-map.ts is its one reader for self-resolution.
 *
 * The rules under test, in the order a wrong resolution would hurt:
 *   - an env id still wins, and a matched claude id is authoritative at any
 *     age (a match IS the session; its ts is refreshed for the next reader);
 *   - knowing one's own id and NOT finding it is never a reason to guess;
 *   - the newest-entry fallback needs the hub to confirm the session live and
 *     needs exactly one candidate — two candidates is one too many, because
 *     the cost of arming the wrong session dwarfs the cost of asking again;
 *   - a missing, malformed or unreadable map is the old refusal, verbatim.
 */
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  resolveSelfSessionId,
  readPaiSessionMap,
  envClaudeSessionId,
  paneSuffix,
  paiSessionMapPath,
  PAI_MAP_FALLBACK_WINDOW_MS,
} from "../src/daemon/pai-session-map.js";
import { callerSelfId } from "../src/daemon/core-handlers.js";
import type { SessionSnapshot } from "../src/adapters/iterm/core.js";
import type { IpcRequest } from "../src/types/ipc.js";

const UID = "066504E1-BB16-48D3-9A74-C1F8BA45B7F3";
const OTHER_UID = "AD45835E-7F1E-40B6-B590-9C466F7A9B25";
const CLAUDE_ID = "f56482bd-fbb6-435e-849a-e33b94bd6835";
const OTHER_CLAUDE_ID = "785eab88-135e-44e9-b1fe-ba4a25270e01";
const NOW = 1_792_458_440_000;

/** A map written into the sandboxed home, where the default path looks. */
function writeMap(entries: Record<string, unknown> | string, file = paiSessionMapPath()): string {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof entries === "string" ? entries : JSON.stringify(entries));
  return file;
}

const freshMap = (ts = NOW - 60_000) => ({
  [CLAUDE_ID]: { uid: UID, ts },
});

const req = (fields: Partial<IpcRequest>): IpcRequest =>
  ({ id: "t", sessionId: "unknown-session", method: "manage", params: {}, ...fields }) as IpcRequest;

const snap = (id: string): SessionSnapshot =>
  ({
    id, name: id, profileName: "Default", tabTitle: null, tty: `/dev/ttys-${id}`,
    atPrompt: true, paiName: null,
  }) as SessionSnapshot;

/** callerSelfId has no clock seam; pin Date.now to NOW so map ages are deterministic. */
async function callerSelfIdAtNow(...args: Parameters<typeof callerSelfId>) {
  const clock = mock.method(Date, "now", () => NOW);
  try {
    return await callerSelfId(...args);
  } finally {
    clock.mock.restore();
  }
}

// ── the pieces ───────────────────────────────────────────────────────────────

test("paneSuffix: iTerm's window/tab/pane form and the bare uuid are the same session", () => {
  assert.equal(paneSuffix(`w0t0p0:${UID}`), UID);
  assert.equal(paneSuffix(UID), UID);
  assert.equal(paneSuffix(undefined), "");
});

test("envClaudeSessionId: CLAUDE_CODE_SESSION_ID first, CLAUDE_SESSION_ID second, neither is no", () => {
  assert.equal(envClaudeSessionId({ CLAUDE_CODE_SESSION_ID: "a", CLAUDE_SESSION_ID: "b" }), "a");
  assert.equal(envClaudeSessionId({ CLAUDE_SESSION_ID: "b" }), "b");
  assert.equal(envClaudeSessionId({}), undefined);
  assert.equal(envClaudeSessionId({ CLAUDE_CODE_SESSION_ID: "   " }), undefined, "blank is absent, not an id");
});

// ── precedence: the env id wins and never consults the map ───────────────────

test("ITERM_SESSION_ID resolves as always — the map is not even read", async () => {
  const r = await resolveSelfSessionId({ itermSessionId: `w7t0p0:${UID}`, mapPath: "/nonexistent/map.json" });
  assert.equal(r?.id, UID);
  assert.equal(r?.via, "iterm-env");
});

// ── path 2: exact claude-id match ────────────────────────────────────────────

test("claude env id + map hit resolves, however old the entry, and refreshes its ts", async () => {
  const file = writeMap(freshMap(NOW - 24 * 3_600_000)); // a day stale — still authoritative
  const r = await resolveSelfSessionId({ env: { CLAUDE_CODE_SESSION_ID: CLAUDE_ID }, mapPath: file, now: NOW });
  assert.equal(r?.id, UID);
  assert.equal(r?.via, "claude-env-id");
  const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, { ts: number }>;
  assert.ok(saved[CLAUDE_ID].ts >= NOW, "the used entry's ts is refreshed for the next reader");
});

test("CLAUDE_SESSION_ID is honoured when the newer name is absent", async () => {
  const file = writeMap(freshMap());
  const r = await resolveSelfSessionId({ env: { CLAUDE_SESSION_ID: CLAUDE_ID }, mapPath: file, now: NOW });
  assert.equal(r?.id, UID);
});

test("both env names set: CLAUDE_CODE_SESSION_ID wins", async () => {
  const file = writeMap({
    [CLAUDE_ID]: { uid: UID, ts: NOW - 60_000 },
    [OTHER_CLAUDE_ID]: { uid: OTHER_UID, ts: NOW - 60_000 },
  });
  const r = await resolveSelfSessionId({
    env: { CLAUDE_CODE_SESSION_ID: CLAUDE_ID, CLAUDE_SESSION_ID: OTHER_CLAUDE_ID },
    mapPath: file, now: NOW,
  });
  assert.equal(r?.id, UID);
});

test("a known claude id absent from the map is refused, not traded for a guess", async () => {
  // The newest-entry fallback would happily answer here — and would name
  // somebody else's session. Knowing one's own id is evidence against guessing.
  const file = writeMap({ [OTHER_CLAUDE_ID]: { uid: OTHER_UID, ts: NOW - 60_000 } });
  const r = await resolveSelfSessionId({
    env: { CLAUDE_CODE_SESSION_ID: CLAUDE_ID }, mapPath: file, now: NOW, knownUids: [OTHER_UID],
  });
  assert.equal(r, undefined);
});

test("a composite uid in the map is answered in the pane-suffix form managers.json is keyed by", async () => {
  const file = writeMap({ [CLAUDE_ID]: { uid: `w0t0p0:${UID}`, ts: NOW - 60_000 } });
  const r = await resolveSelfSessionId({ env: { CLAUDE_CODE_SESSION_ID: CLAUDE_ID }, mapPath: file, now: NOW });
  assert.equal(r?.id, UID);
});

test("a map entry without a usable uid does not resolve", async () => {
  const file = writeMap({ [CLAUDE_ID]: { ts: NOW - 60_000 } });
  assert.equal(await resolveSelfSessionId({ env: { CLAUDE_CODE_SESSION_ID: CLAUDE_ID }, mapPath: file, now: NOW }), undefined);
});

test("an unwritable map does not undo a resolution that already succeeded", async () => {
  const file = writeMap(freshMap(NOW - 60_000));
  chmodSync(file, 0o444);
  try {
    const r = await resolveSelfSessionId({ env: { CLAUDE_CODE_SESSION_ID: CLAUDE_ID }, mapPath: file, now: NOW });
    assert.equal(r?.id, UID, "the refresh is best effort; the match stands");
    assert.equal(r?.mapRefreshed, false);
  } finally {
    chmodSync(file, 0o644);
  }
});

// ── path 3: the unambiguous fresh entry naming a live session ────────────────

test("no ids at all + exactly one fresh entry naming a live session → resolves", async () => {
  const file = writeMap(freshMap(NOW - 60_000));
  const r = await resolveSelfSessionId({ mapPath: file, now: NOW, knownUids: [OTHER_UID, UID] });
  assert.equal(r?.id, UID);
  assert.equal(r?.via, "newest-fresh");
});

test("two fresh live entries → refused — one candidate too many to act on", async () => {
  const file = writeMap({
    [CLAUDE_ID]: { uid: UID, ts: NOW - 60_000 },
    [OTHER_CLAUDE_ID]: { uid: OTHER_UID, ts: NOW - 120_000 },
  });
  assert.equal(await resolveSelfSessionId({ mapPath: file, now: NOW, knownUids: [UID, OTHER_UID] }), undefined);
});

test("a fresh entry the hub cannot confirm live is not resolved from", async () => {
  const file = writeMap(freshMap(NOW - 60_000));
  assert.equal(await resolveSelfSessionId({ mapPath: file, now: NOW, knownUids: [] }), undefined);
  assert.equal(await resolveSelfSessionId({ mapPath: file, now: NOW, knownUids: [OTHER_UID] }), undefined);
});

test("an entry older than the 2h window is not a candidate, even when its session is live", async () => {
  const file = writeMap(freshMap(NOW - PAI_MAP_FALLBACK_WINDOW_MS - 60_000));
  assert.equal(await resolveSelfSessionId({ mapPath: file, now: NOW, knownUids: [UID] }), undefined);
});

// ── the registry itself ──────────────────────────────────────────────────────

test("map missing → nothing, which is the old refusal", async () => {
  assert.equal(readPaiSessionMap("/nonexistent/map.json"), undefined);
  assert.equal(await resolveSelfSessionId({ mapPath: "/nonexistent/map.json", env: { CLAUDE_CODE_SESSION_ID: CLAUDE_ID } }), undefined);
});

test("map malformed → nothing, which is the old refusal", async () => {
  const file = writeMap("not json at all{{{");
  assert.equal(readPaiSessionMap(file), undefined);
  assert.equal(await resolveSelfSessionId({ mapPath: file, env: { CLAUDE_CODE_SESSION_ID: CLAUDE_ID } }), undefined);
});

test("map not an object → nothing", async () => {
  const file = writeMap(["an", "array"]);
  assert.equal(readPaiSessionMap(file), undefined);
});

// ── the hub side: callerSelfId ───────────────────────────────────────────────

test("a request carrying an iTerm id resolves exactly as before", async () => {
  assert.equal(await callerSelfIdAtNow(req({ itermSessionId: `w0t0p0:${UID}` }), []), UID);
  assert.equal(await callerSelfIdAtNow(req({ sessionId: `w11t0p0:${UID}` }), []), UID, "the TERM-derived claim still passes through");
});

test("unknown-session + claude uuid in the request + map hit → the map's uid", async () => {
  writeMap(freshMap());
  const r = await callerSelfIdAtNow(req({ claudeSessionId: CLAUDE_ID }), []);
  assert.equal(r, UID);
});

test("unknown-session + no uuid + one fresh entry naming a live pane → that pane", async () => {
  writeMap(freshMap(NOW - 60_000));
  const r = await callerSelfIdAtNow(req({}), [snap(OTHER_UID), snap(UID)]);
  assert.equal(r, UID);
});

test("unknown-session + two fresh live candidates → undefined, the caller is told to name itself", async () => {
  writeMap({
    [CLAUDE_ID]: { uid: UID, ts: NOW - 60_000 },
    [OTHER_CLAUDE_ID]: { uid: OTHER_UID, ts: NOW - 120_000 },
  });
  assert.equal(await callerSelfIdAtNow(req({}), [snap(UID), snap(OTHER_UID)]), undefined);
});

test("unknown-session + no map at all → undefined, exactly the old refusal", async () => {
  rmSync(paiSessionMapPath(), { force: true });
  assert.equal(await callerSelfIdAtNow(req({ claudeSessionId: CLAUDE_ID }), []), undefined);
  assert.equal(await callerSelfIdAtNow(req({}), [snap(UID)]), undefined);
});
