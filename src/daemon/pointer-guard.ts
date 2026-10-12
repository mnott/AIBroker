/**
 * pointer-guard.ts — never type into a pane whose input line holds unsent text.
 *
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
import type { AckResult } from "./sessions.js";

export const RETRY_MS = 20_000;
export const GIVEUP_MS = 10 * 60_000;
export const HELD_REASON = "input line holds unsent text — not typed";
export const UNREADABLE_REASON = "could not read the target terminal — not typed";

export interface GuardDeps {
  /** Live pane text, or null when it cannot be read. */
  read(sessionId: string): Promise<string | null>;
  type(sessionId: string, text: string): Promise<AckResult>;
  mailboxSize(sessionId: string): number;
  now(): number;
  setTimer(fn: () => void, ms: number): { unref?: () => void } | unknown;
  clearTimer(t: unknown): void;
}

export const realGuardDeps: GuardDeps = {
  read: async (id) => {
    try { return (await readSessionContentAsync(id, 60, { fresh: true }))?.content ?? null; } catch { return null; }
  },
  type: async (id, text) => {
    const { submitAndConfirm } = await import("./dispatch.js");
    return submitAndConfirm(id, text, 15_000, undefined, 1);
  },
  mailboxSize: (id) => peekSessionMailbox(id).length,
  now: () => Date.now(),
  setTimer: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  clearTimer: (t) => clearTimeout(t as NodeJS.Timeout),
};

export type GuardResult =
  | { typed: true; ack: AckResult }
  | { typed: false; reason: string };

interface Pending { timer: unknown; deadline: number; text: string; multi?: (n: number) => string }
const pending = new Map<string, Pending>();

/** Test hook: forget all pending retries. */
export function resetPointerGuard(deps: GuardDeps = realGuardDeps): void {
  for (const p of pending.values()) deps.clearTimer(p.timer);
  pending.clear();
}

async function inputState(sessionId: string, deps: GuardDeps): Promise<"empty" | "held" | "unreadable"> {
  const pane = await deps.read(sessionId);
  if (pane === null) return "unreadable";
  return promptUnsentText(pane) ? "held" : "empty";
}

function schedule(sessionId: string, p: Pending, deps: GuardDeps): void {
  p.timer = deps.setTimer(() => { void retry(sessionId, deps); }, RETRY_MS);
}

async function retry(sessionId: string, deps: GuardDeps): Promise<void> {
  const p = pending.get(sessionId);
  if (!p) return;
  const n = deps.mailboxSize(sessionId);
  if (n === 0 || deps.now() >= p.deadline) { pending.delete(sessionId); return; }
  if ((await inputState(sessionId, deps)) !== "empty") {
    // Re-read the entry: another message may have joined while we awaited.
    const cur = pending.get(sessionId);
    if (cur) schedule(sessionId, cur, deps);
    return;
  }
  pending.delete(sessionId);
  const count = deps.mailboxSize(sessionId);
  await deps.type(sessionId, count > 1 && p.multi ? p.multi(count) : p.text);
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
  const state = await inputState(sessionId, deps);
  if (state === "empty") {
    return { typed: true, ack: await deps.type(sessionId, text) };
  }
  const existing = pending.get(sessionId);
  if (existing) {
    // One pointer per target: keep the first text, let multi() cover the rest.
    existing.multi ??= opts.multi;
  } else {
    const p: Pending = { timer: undefined, deadline: deps.now() + GIVEUP_MS, text, multi: opts.multi };
    pending.set(sessionId, p);
    schedule(sessionId, p, deps);
  }
  return { typed: false, reason: state === "held" ? HELD_REASON : UNREADABLE_REASON };
}
