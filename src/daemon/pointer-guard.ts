/**
 * pointer-guard.ts — never type into a pane whose input line holds unsent text.
 *
 * (Default mode "send" now types anyway; see PointerGuardMode. This describes "hold".)
 * A typed `[Session:...]` pointer plus Enter lands in the middle of whatever the
 * operator is typing and submits the half sentence with it; the rest is lost.
 * So every typer of an unsolicited line goes through typeWhenInputEmpty():
 * read the live pane first, type only when the input box is empty, and when it
 * is not (or the pane cannot be read) type nothing — the caller has already
 * deposited the message in the mailbox, so nothing is lost.
 *
 * A held line is retried every RETRY_MS for up to GIVEUP_MS, one pending entry
 * per target. The retry stops early when the mailbox has been drained (the
 * drain already showed the message).
 */
import { peekSessionMailbox } from "../core/state.js";
import { readSessionContentAsync } from "./session-content.js";
import { promptUnsentText } from "./manage.js";
import { audit } from "./audit.js";
import type { AckResult } from "./sessions.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * "send" (default): type the pointer even when the input line holds text; a held
 * line that is itself an earlier pointer is cleared first. "hold": never type
 * into held text (pointer stays in the mailbox, retried until the line clears).
 */
export type PointerGuardMode = "send" | "hold";
export const STALE_CLEARED = "cleared stale pointer, typed";
export const TYPED_OVER = "typed over unsent text";
/** A held line made only of pointers the hub types: [Session:…], [Keepalive], [Task…], [Inbound:…], [a2a], [PAILot]. */
export const STALE_POINTER_RE = /^\s*\[(?:Session:[^\]]*|Keepalive|Task[^\]]*|Inbound:[^\]]*|a2a|PAILot)\]/;
export function isStalePointer(text: string): boolean { return STALE_POINTER_RE.test(text); }

/** `pointerGuard` from ~/.aibroker/config.json; anything but "hold" means "send". */
export function loadPointerGuardMode(path: string = join(homedir(), ".aibroker", "config.json")): PointerGuardMode {
  try {
    const v = (JSON.parse(readFileSync(path, "utf8")) as { pointerGuard?: unknown }).pointerGuard;
    return v === "hold" ? "hold" : "send";
  } catch { return "send"; }
}

export const RETRY_MS = 20_000;
export const GIVEUP_MS = 60 * 60_000;
/** The input line must stay empty and unchanged this long before anything is typed. */
export const QUIET_MS = 2_000;
export const HELD_REASON = "input line holds unsent text — not typed";
/** HELD_REASON plus what the guard saw (first 80 chars), so a wrong verdict can be diagnosed. */
export function heldReason(text: string): string {
  const t = text.length > 80 ? `${text.slice(0, 80)}…` : text;
  return `input line holds unsent text: "${t}" — not typed`;
}
export const UNREADABLE_REASON = "could not read the target terminal — not typed";

export interface GuardDeps {
  /** Live pane text, or null when it cannot be read. */
  read(sessionId: string): Promise<string | null>;
  type(sessionId: string, text: string): Promise<AckResult>;
  /** Clear the input line (ctrl-U). */
  clear(sessionId: string): Promise<unknown>;
  mode(): PointerGuardMode;
  mailboxSize(sessionId: string): number;
  now(): number;
  sleep(ms: number): Promise<void>;
  setTimer(fn: () => void, ms: number): { unref?: () => void } | unknown;
  clearTimer(t: unknown): void;
  audit(e: Parameters<typeof audit>[0]): unknown;
}

export const realGuardDeps: GuardDeps = {
  read: async (id) => {
    try { return (await readSessionContentAsync(id, 60, { fresh: true }))?.content ?? null; } catch { return null; }
  },
  type: async (id, text) => {
    const { submitAndConfirm } = await import("./dispatch.js");
    return submitAndConfirm(id, text, 15_000, undefined, 1);
  },
  clear: async (id) => {
    const { sendControlU } = await import("../transport/sync-facade.js");
    return sendControlU(id);
  },
  mode: () => loadPointerGuardMode(),
  mailboxSize: (id) => peekSessionMailbox(id).length,
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  setTimer: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  clearTimer: (t) => clearTimeout(t as NodeJS.Timeout),
  audit: (e) => audit(e),
};

export type GuardResult =
  | { typed: true; ack: AckResult; how?: typeof STALE_CLEARED | typeof TYPED_OVER }
  | { typed: false; reason: string };

interface Pending { timer: unknown; since: number; lastText: string; deadline: number; text: string; multi?: (n: number) => string }
const pending = new Map<string, Pending>();

/** Test hook: forget all pending retries. */
export function resetPointerGuard(deps: GuardDeps = realGuardDeps): void {
  for (const p of pending.values()) deps.clearTimer(p.timer);
  pending.clear();
}

type InputState = { state: "empty" | "unreadable" } | { state: "held"; text: string };

async function inputState(sessionId: string, deps: GuardDeps): Promise<InputState> {
  const pane = await deps.read(sessionId);
  if (pane === null) return { state: "unreadable" };
  const first = promptUnsentText(pane);
  if (first) return { state: "held", text: first };
  // Empty now is not idle: the operator may be about to start a sentence. Require
  // the line to still be empty after a quiet window, so typing that began since
  // the first read is seen rather than landed in the middle of.
  await deps.sleep(QUIET_MS);
  const again = await deps.read(sessionId);
  if (again === null) return { state: "unreadable" };
  const second = promptUnsentText(again);
  return second ? { state: "held", text: second } : { state: "empty" };
}

function schedule(sessionId: string, p: Pending, deps: GuardDeps): void {
  p.timer = deps.setTimer(() => { void retry(sessionId, deps); }, RETRY_MS);
}

async function retry(sessionId: string, deps: GuardDeps): Promise<void> {
  const p = pending.get(sessionId);
  if (!p) return;
  const n = deps.mailboxSize(sessionId);
  if (n === 0) { pending.delete(sessionId); return; }
  if (deps.now() >= p.deadline) {
    pending.delete(sessionId);
    deps.audit({
      action: "send", actor: "pointer-guard", target: sessionId, outcome: "gave-up",
      reason: `input line never cleared; last seen: "${p.lastText.slice(0, 80)}"`,
      meta: { waitedSeconds: Math.round((deps.now() - p.since) / 1000) },
    });
    return;
  }
  const st = await inputState(sessionId, deps);
  if (st.state !== "empty") {
    // Re-read the entry: another message may have joined while we awaited.
    const cur = pending.get(sessionId);
    if (cur) {
      if (st.state === "held") cur.lastText = st.text;
      schedule(sessionId, cur, deps);
    }
    return;
  }
  pending.delete(sessionId);
  const count = deps.mailboxSize(sessionId);
  const ack = await deps.type(sessionId, count > 1 && p.multi ? p.multi(count) : p.text);
  deps.audit({
    action: "send", actor: "pointer-guard", target: sessionId, outcome: "delivered-late",
    reason: `typed after the input line cleared (ack ${ack})`,
    meta: { waitedSeconds: Math.round((deps.now() - p.since) / 1000) },
  });
}

/**
 * Type `text` into the session only if its input line is empty.
 *
 * `multi` builds the single line typed instead when several messages have
 * piled up behind a held line ("N messages"); omit it for text that is not a
 * mailbox pointer (it is then retried as-is).
 */
export async function typeWhenInputEmpty(
  sessionId: string,
  text: string,
  opts: { multi?: (n: number) => string } = {},
  deps: GuardDeps = realGuardDeps,
): Promise<GuardResult> {
  const st = await inputState(sessionId, deps);
  const state = st.state;
  if (state === "empty") {
    return { typed: true, ack: await deps.type(sessionId, text) };
  }
  // Operator decision 2026-11-18: held text does not stop a pointer. An unreadable
  // pane (nothing to judge) and mode "hold" keep the old behaviour below.
  if (st.state === "held" && deps.mode() === "send") {
    const stale = isStalePointer(st.text);
    if (stale) await deps.clear(sessionId);
    const ack = await deps.type(sessionId, text);
    deps.audit({
      action: "send", actor: "pointer-guard", target: sessionId, outcome: "delivered",
      reason: stale ? STALE_CLEARED : TYPED_OVER, meta: { held: st.text.slice(0, 80) },
    });
    return { typed: true, ack, how: stale ? STALE_CLEARED : TYPED_OVER };
  }
  const existing = pending.get(sessionId);
  if (existing) {
    // One pointer per target: keep the first text, let multi() cover the rest.
    existing.multi ??= opts.multi;
  } else {
    const p: Pending = { timer: undefined, since: deps.now(), lastText: st.state === "held" ? st.text : "", deadline: deps.now() + GIVEUP_MS, text, multi: opts.multi };
    pending.set(sessionId, p);
    schedule(sessionId, p, deps);
  }
  return { typed: false, reason: st.state === "held" ? heldReason(st.text) : UNREADABLE_REASON };
}
