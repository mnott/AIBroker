/**
 * state.ts — Transport-agnostic mutable state for the watcher subsystem.
 *
 * All shared runtime state lives here. No transport SDK imports.
 * Transport-specific state (Baileys socket, GramJS client, chat/message stores)
 * remains in the per-project packages.
 */

import { sameClaudeSession } from "./claude-attach.js";
import type {
  RegisteredSession,
  QueuedMessage,
  ClientWaiter,
  ContactEntry,
  VoiceConfig,
} from "../types/index.js";

// ── Session Registry ──

export const sessionRegistry = new Map<string, RegisteredSession>();
export const managedSessions = new Map<string, { name: string; createdAt: number }>();
export const sessionTtyCache = new Map<string, string>();

export let activeClientId: string | null = null;
export let activeItermSessionId = "";

// Track the session that last received user input from PAILot.
// Used to tag responses correctly even if the user switches sessions
// before the response arrives (race condition prevention).
export let lastRoutedSessionId = "";

export function setLastRoutedSessionId(id: string): void {
  lastRoutedSessionId = id;
}

export function setActiveClientId(id: string | null): void {
  activeClientId = id;
}

export function setActiveItermSessionId(id: string): void {
  activeItermSessionId = id;
}

export function updateSessionTtyCache(entries: Array<{ id: string; tty: string }>): void {
  for (const { id, tty } of entries) {
    if (tty) sessionTtyCache.set(id, tty);
  }
}

// ── Cached Session List (for /s and /N commands) ──

export let cachedSessionList: Array<{
  id: string;
  name: string;
  path: string;
  type: "claude" | "terminal";
  paiName: string | null;
  atPrompt: boolean;
}> | null = null;

export let cachedSessionListTime = 0;

export function setCachedSessionList(
  list: typeof cachedSessionList,
  time: number,
): void {
  cachedSessionList = list;
  cachedSessionListTime = time;
}

// ── Message Queues ──

export const clientQueues = new Map<string, QueuedMessage[]>();
export const clientWaiters = new Map<string, ClientWaiter[]>();
export const contactMessageQueues = new Map<string, QueuedMessage[]>();

// ── Contact Directory ──

export const contactDirectory = new Map<string, ContactEntry>();

// ── Voice Config ──

export let voiceConfig: VoiceConfig = {
  defaultVoice: "bm_fable",
  voiceMode: false,
  localMode: false,
  personas: {},
};

export function setVoiceConfig(cfg: VoiceConfig): void {
  voiceConfig = cfg;
}

// ── AIBP Bridge (singleton, set by daemon at startup) ──

import type { AibpBridge } from "../aibp/bridge.js";

let _aibpBridge: AibpBridge | null = null;

export function setAibpBridge(bridge: AibpBridge): void {
  _aibpBridge = bridge;
}

export function getAibpBridge(): AibpBridge | null {
  return _aibpBridge;
}

// ── Command Handler ──

export type CommandHandler = (text: string, timestamp: number) => void | Promise<void>;

export let commandHandler: CommandHandler | null = null;

export function setCommandHandler(handler: CommandHandler | null): void {
  commandHandler = handler;
}

// ── Message Source (routing context: which transport originated the current message) ──

export type MessageSource = string;  // "whatsapp" | "pailot" | "telex" | ...
export let messageSource: MessageSource = "whatsapp";

export function setMessageSource(src: MessageSource): void {
  messageSource = src;
}

// ── Self-Echo Suppression ──

export const sentMessageIds = new Set<string | number>();

// ── Session Mailboxes ──
// Per-session message queues for structured inter-session messaging.
// A session's mailbox is keyed by its iTerm2 session ID.
// Messages are deposited by send_to_session and drained by aibroker_receive.

export interface MailboxMessage {
  from: string;       // sender label (session name or "hub")
  content: string;    // message text
  timestamp: number;  // Unix ms
  /**
   * Set once this message has been reported as stale.
   *
   * "Queued" is an honest answer at the moment of sending and a false one four
   * hours later: a message nobody drained is undelivered, not pending. The flag
   * exists so the fault is reported once rather than every sweep.
   */
  staleReported?: boolean;
  /**
   * Unix ms the drain-mailbox hook emitted this message. The hook's output does
   * not always reach the model (a message typed mid-turn lost its body live on
   * 2026-10-10), so the hook marks instead of deleting: aibroker_receive still
   * returns it, flagged, until it is read or SHOWN_RETAIN_MS passes. Absent on
   * entries that predate the flag, which therefore count as unshown.
   */
  shownAt?: number;
}

const sessionMailboxes = new Map<string, MailboxMessage[]>();

const MAX_MAILBOX = 100;
const SHOWN_RETAIN_MS = 30 * 60 * 1000;

function pruneShown(queue: MailboxMessage[], now: number): void {
  for (let i = queue.length - 1; i >= 0; i--) {
    const at = queue[i].shownAt;
    if (at !== undefined && now - at > SHOWN_RETAIN_MS) queue.splice(i, 1);
  }
}

/**
 * Deposit a message, returning anything the queue had to drop to fit it.
 *
 * The overflow used to be a bare `shift()`. A message evicted that way was
 * undelivered and left no trace anywhere — the same silent drop this mailbox
 * exists to prevent, one level down. The caller gets it back so it can be
 * recorded.
 */
export function depositToSessionMailbox(
  itermSessionId: string,
  from: string,
  content: string,
): MailboxMessage | undefined {
  let queue = sessionMailboxes.get(itermSessionId);
  if (!queue) {
    queue = [];
    sessionMailboxes.set(itermSessionId, queue);
  }
  let dropped: MailboxMessage | undefined;
  pruneShown(queue, Date.now());
  if (queue.length >= MAX_MAILBOX) {
    // Already-shown messages go first: the model has seen those.
    const i = queue.findIndex((m) => m.shownAt !== undefined);
    dropped = queue.splice(i === -1 ? 0 : i, 1)[0];
  }
  queue.push({ from, content, timestamp: Date.now() });
  return dropped;
}

/**
 * Read-only view of every mailbox, for anything that needs to age its contents.
 *
 * Returns the live message objects deliberately: a sweep marks what it has
 * already reported, and copying would lose that.
 */
export function listSessionMailboxes(): Array<{ sessionId: string; messages: MailboxMessage[] }> {
  return [...sessionMailboxes.entries()].map(([sessionId, messages]) => ({ sessionId, messages }));
}

/**
 * Panes that only VIEW a Claude background session (`claude attach <uuid>`),
 * pane id → session uuid. send_to_session resolves a name to the visible pane,
 * but the session's hook and MCP server identify as the pane it was started
 * in, so a mailbox keyed by pane alone is never drained. The alias lets
 * drain/receive by (own id, session uuid) read the viewer pane's mailbox too.
 */
const attachAliases = new Map<string, string>();

export function setAttachAlias(paneId: string, claudeSessionId: string | undefined): void {
  if (claudeSessionId) attachAliases.set(paneId, claudeSessionId);
  else attachAliases.delete(paneId);
}

/** Claude session uuid last seen for an iTerm id, so a dead id can be redirected. */
const idSessions = new Map<string, string>();

export function rememberIdSession(id: string, claudeSessionId: string | undefined): void {
  if (claudeSessionId) idSessions.set(id, claudeSessionId);
}

export function claudeSessionOfId(id: string): string | undefined {
  return idSessions.get(id);
}

/**
 * The pane that actually serves an id. An id that is not a live Claude pane
 * (its session was moved into a background session, the old pane is gone or a
 * shell) maps to the `claude attach` pane of the same Claude session, when its
 * uuid was seen; every other id is returned unchanged.
 */
export function liveSessionFor(
  id: string,
  snaps: { id: string; isClaude?: boolean; attachUuid?: string }[],
): string {
  const uuid = claudeSessionOfId(id);
  if (!uuid || snaps.find((s) => s.id === id)?.isClaude === true) return id;
  return snaps.find((s) => s.attachUuid && sameClaudeSession(s.attachUuid, uuid))?.id ?? id;
}

/** Whether an attach pane is already known for this Claude session uuid. */
export function hasAttachAlias(claudeSessionId: string): boolean {
  for (const uuid of attachAliases.values()) if (sameClaudeSession(uuid, claudeSessionId)) return true;
  return false;
}

/** Every mailbox key a caller reads: its own id plus any pane viewing its session. */
export function mailboxKeys(id: string | undefined, claudeSessionId?: string): string[] {
  const keys = id ? [id] : [];
  if (claudeSessionId) {
    for (const [pane, uuid] of attachAliases) {
      if (pane !== id && sameClaudeSession(uuid, claudeSessionId)) keys.push(pane);
    }
  }
  return keys;
}

const asKeys = (ids: string | string[]): string[] => (typeof ids === "string" ? [ids] : ids);

/** Unshown messages across the keys, oldest first; prunes as it goes. */
function unshownAcross(ids: string | string[], now: number): MailboxMessage[] {
  const out: MailboxMessage[] = [];
  for (const id of asKeys(ids)) {
    const queue = sessionMailboxes.get(id);
    if (!queue) continue;
    pruneShown(queue, now);
    out.push(...queue.filter((m) => m.shownAt === undefined));
  }
  return out.sort((x, y) => x.timestamp - y.timestamp);
}

/**
 * Non-destructive read of one mailbox (or several, see mailboxKeys), for the
 * two-phase drain (peek → emit → ack) the drain-mailbox hook uses. Copy, not
 * the live queue, so the caller cannot mutate what a later ack will clear.
 */
export function peekSessionMailbox(ids: string | string[], now: number = Date.now()): MailboxMessage[] {
  return unshownAcross(ids, now);
}

/**
 * Phase 2 of the hook's drain: mark the oldest `count` unshown messages as
 * shown instead of deleting them. A count (not "all") so a message deposited
 * after the peek stays unshown for the next one.
 */
export function markMailboxShown(ids: string | string[], count: number, now: number = Date.now()): number {
  const todo = unshownAcross(ids, now).slice(0, count);
  for (const m of todo) m.shownAt = now;
  return todo.length;
}

/** The explicit read (aibroker_receive): everything left, shown or not, then clear. */
export function drainSessionMailbox(ids: string | string[], now: number = Date.now()): MailboxMessage[] {
  const out: MailboxMessage[] = [];
  for (const id of asKeys(ids)) {
    const queue = sessionMailboxes.get(id);
    if (!queue) continue;
    pruneShown(queue, now);
    out.push(...queue.splice(0));
  }
  return out.sort((x, y) => x.timestamp - y.timestamp);
}

// ── Mailbox waiters ──
// `aibroker mailbox wait` heartbeats through session_mailbox_peek; a waiter is
// active while its last heartbeat is recent, so a dead process drops out alone.
const WAITER_TTL_MS = 5000;
const waiterSeen = new Map<string, number>();

export function registerMailboxWaiter(ids: string | string[], now: number = Date.now()): void {
  for (const id of asKeys(ids)) waiterSeen.set(id, now);
}

export function hasActiveWaiter(ids: string | string[] | undefined, now: number = Date.now()): boolean {
  if (!ids) return false;
  return asKeys(ids).some((id) => now - (waiterSeen.get(id) ?? -Infinity) <= WAITER_TTL_MS);
}

export function activeWaiters(now: number = Date.now()): string[] {
  return [...waiterSeen].filter(([, at]) => now - at <= WAITER_TTL_MS).map(([id]) => id);
}

// ── Message Dispatch ──

export function dispatchIncomingMessage(body: string, timestamp: number): void {
  if (!activeClientId) return;

  const msg: QueuedMessage = { body, timestamp };
  const waiters = clientWaiters.get(activeClientId);

  if (waiters && waiters.length > 0) {
    const waiter = waiters.shift()!;
    waiter([msg]);
  } else {
    let queue = clientQueues.get(activeClientId);
    if (!queue) {
      queue = [];
      clientQueues.set(activeClientId, queue);
    }
    queue.push(msg);
  }
}

export function enqueueContactMessage(
  contactId: string,
  body: string,
  timestamp: number,
): void {
  let queue = contactMessageQueues.get(contactId);
  if (!queue) {
    queue = [];
    contactMessageQueues.set(contactId, queue);
  }
  queue.push({ body, timestamp });
}
