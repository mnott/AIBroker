/**
 * state.ts — Transport-agnostic mutable state for the watcher subsystem.
 *
 * All shared runtime state lives here. No transport SDK imports.
 * Transport-specific state (Baileys socket, GramJS client, chat/message stores)
 * remains in the per-project packages.
 */

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
