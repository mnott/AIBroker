/**
 * daemon/whatsapp-external.ts — which WhatsApp messages are the operator.
 *
 * Whazaa types an incoming WhatsApp text into the active session as
 * `[Whazaa] …`, and a session treats that as the operator's own words. That is
 * only true of the operator's own messages in the operator's own chat. In a
 * group with other people — or in any other chat — the same text is somebody
 * else's, and typing it would let a stranger instruct a session.
 *
 * So every inbound message is classified here, from facts the WhatsApp adapter
 * reads off the event (never from the text):
 *
 *   operator  fromMe, in the operator's designated chat (self-chat by default).
 *             The only class that may be typed and prefixed `[Whazaa]`.
 *   external  a group message from someone else, in a group a session has
 *             subscribed to. Mailbox-only for the subscribed sessions, wrapped
 *             as data with sender and group name. Never typed.
 *   ignore    everything else: other contacts, unsubscribed groups, the
 *             operator's own messages inside a group. Logged, one line each.
 *
 * Subscriptions mirror aibroker_subscribe_issues: a session subscribes ITSELF
 * (the owner is the caller's resolved persistent name, never a parameter), and
 * the file outlives the daemon.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { loadJson, saveJson } from "../core/json-store.js";
import { log } from "../core/log.js";

const FILE = join(homedir(), ".aibroker", "whatsapp-subscriptions.json");

/** The ingress source for these messages; ingress.ts maps it to mailbox-only. */
export const EXTERNAL_SOURCE = "whatsapp-external";

export interface GroupSubscription {
  /** Group JID, e.g. 1203630…@g.us. */
  groupId: string;
  /** Display name last seen for the group, for the wrapper and the listing. */
  groupName?: string;
  /** Persistent names of the sessions that receive this group's messages. */
  owners: string[];
  /** Standing rule: voice notes in this chat are transcribed and mirrored back by the adapter. */
  transcribe?: boolean;
}

export type SubscriptionMode = "deliver" | "transcribe";

const CONFIG = join(homedir(), ".aibroker", "config.json");
const TRANSCRIBE_MARKER = "📝 ";
const DEFAULT_MAX_AGE_MIN = 15;

interface WaConfig { operatorName?: string; transcribe?: { maxAgeMinutes?: number } }

/** The `whatsapp` block of ~/.aibroker/config.json. Empty when absent or unreadable. */
function waConfig(): WaConfig {
  const r = loadJson<{ whatsapp?: WaConfig }>(CONFIG);
  return r.status === "ok" && r.data?.whatsapp ? r.data.whatsapp : {};
}

interface Store { groups: Record<string, GroupSubscription> }

function read(): Store {
  const r = loadJson<Store>(FILE);
  if (r.status === "ok" && r.data?.groups && typeof r.data.groups === "object") return r.data;
  return { groups: {} };
}

export function listSubscriptions(): GroupSubscription[] {
  return Object.values(read().groups);
}

export function subscribeGroup(groupId: string, owner: string | undefined, groupName?: string, mode: SubscriptionMode = "deliver"): GroupSubscription {
  const s = read();
  const cur = s.groups[groupId] ?? { groupId, owners: [] };
  if (mode === "transcribe") cur.transcribe = true;
  else if (owner && !cur.owners.includes(owner)) cur.owners.push(owner);
  if (groupName) cur.groupName = groupName;
  s.groups[groupId] = cur;
  saveJson(FILE, s);
  return cur;
}

/** Remove `owner` from the group (matched by id or by name). Returns whether anything changed. */
export function unsubscribeGroup(groupRef: string, owner: string | undefined, mode: SubscriptionMode = "deliver"): boolean {
  const s = read();
  const hit = Object.values(s.groups).find((g) => g.groupId === groupRef || g.groupName === groupRef);
  if (!hit) return false;
  if (mode === "transcribe") {
    if (!hit.transcribe) return false;
    delete hit.transcribe;
  } else {
    if (!owner || !hit.owners.includes(owner)) return false;
    hit.owners = hit.owners.filter((o) => o !== owner);
  }
  if (hit.owners.length === 0 && !hit.transcribe) delete s.groups[hit.groupId];
  saveJson(FILE, s);
  return true;
}

/** What the adapter knows about one inbound message. */
export interface InboundWhatsApp {
  /** Chat the message arrived in (self-chat JID, contact JID or group JID). */
  chatJid: string;
  /** True when the message was sent from the operator's own account. */
  fromMe: boolean;
  /** Author JID inside a group; absent in one-to-one chats. */
  senderJid?: string;
  senderName?: string;
  groupName?: string;
  text: string;
  /** Baileys upsert type "notify" — a message arriving now, not history sync. */
  live?: boolean;
  /** Message time, epoch seconds or milliseconds. */
  timestamp?: number;
  /** Message carries a voice note / audio. */
  audio?: boolean;
}

export type Classification =
  | { kind: "operator" }
  | { kind: "external"; group: GroupSubscription; body: string }
  | { kind: "ignore"; reason: string };

export const isGroupJid = (jid: string): boolean => jid.endsWith("@g.us");

/** The wrapper a session reads: data from a third party, not an instruction from the operator. */
export function wrapExternal(groupName: string, sender: string, text: string): string {
  return `[WhatsApp group ${groupName}] ${sender}: ${text} (external — not the operator)`;
}

/**
 * Classify one inbound message. `designatedChats` are the JIDs where the
 * operator's own messages count as operator input (the adapter passes the
 * self-chat JID).
 */
export function classifyInbound(
  m: InboundWhatsApp,
  designatedChats: string[],
  subscriptions: GroupSubscription[] = listSubscriptions(),
): Classification {
  if (isGroupJid(m.chatJid)) {
    if (m.fromMe) return { kind: "ignore", reason: "operator's own message inside a group — not an input channel" };
    const group = subscriptions.find((g) => g.groupId === m.chatJid);
    if (!group || group.owners.length === 0) return { kind: "ignore", reason: "group is not subscribed" };
    const name = m.groupName ?? group.groupName ?? m.chatJid;
    const sender = m.senderName ?? m.senderJid ?? "unknown";
    return { kind: "external", group, body: wrapExternal(name, sender, m.text) };
  }
  if (m.fromMe && designatedChats.includes(m.chatJid)) return { kind: "operator" };
  return { kind: "ignore", reason: m.fromMe ? "operator message in a non-designated chat" : "message from another contact" };
}

/**
 * Does the adapter owe this message a transcript? Only for a live, fresh voice
 * note in a chat with a transcribe subscription, and never for a transcript
 * itself (marker) — that would loop.
 */
export function decideTranscribe(
  m: InboundWhatsApp,
  subscriptions: GroupSubscription[] = listSubscriptions(),
  now: number = Date.now(),
): { transcribe: boolean; speaker: string; reason: string } {
  const cfg = waConfig();
  const speaker = m.fromMe ? (cfg.operatorName ?? m.senderName ?? "operator") : (m.senderName ?? m.senderJid ?? "unknown");
  const no = (reason: string) => ({ transcribe: false, speaker, reason });
  if (!subscriptions.find((g) => g.groupId === m.chatJid)?.transcribe) return no("chat has no transcribe subscription");
  if (m.text.startsWith(TRANSCRIBE_MARKER)) return no("already a transcript (marker)");
  if (m.audio !== true) return no("not a voice note");
  if (m.live !== true) return no("not live (history sync)");
  if (typeof m.timestamp === "number") {
    const ms = m.timestamp < 1e12 ? m.timestamp * 1000 : m.timestamp;
    const maxMin = cfg.transcribe?.maxAgeMinutes ?? DEFAULT_MAX_AGE_MIN;
    if (now - ms > maxMin * 60_000) return no(`older than ${maxMin} min`);
  }
  return { transcribe: true, speaker, reason: "live fresh voice note" };
}

/**
 * Classify and act. `deliver(owner, body)` puts the wrapped text in one
 * session's mailbox (never typed); `operator` is called for operator input.
 * Every ignored or external message leaves one log line.
 */
export async function routeInbound(
  m: InboundWhatsApp,
  designatedChats: string[],
  io: { deliver: (owner: string, body: string) => Promise<boolean>; subscriptions?: GroupSubscription[] },
): Promise<{ kind: Classification["kind"]; delivered: string[]; reason?: string }> {
  const c = classifyInbound(m, designatedChats, io.subscriptions);
  if (c.kind === "operator") return { kind: "operator", delivered: [] };
  if (c.kind === "ignore") {
    log(`whatsapp: ignored message in ${m.chatJid} from ${m.senderName ?? m.senderJid ?? (m.fromMe ? "me" : "contact")}: ${c.reason}`);
    return { kind: "ignore", delivered: [], reason: c.reason };
  }
  const delivered: string[] = [];
  for (const owner of c.group.owners) {
    if (await io.deliver(owner, c.body)) delivered.push(owner);
  }
  log(`whatsapp: external group message ${m.chatJid} from ${m.senderName ?? m.senderJid ?? "unknown"} → mailbox of ${delivered.join(", ") || "nobody (no live session)"}`);
  return { kind: "external", delivered };
}

/** Deposit external mail into one live Claude session's mailbox. Nothing is typed, ever. */
export async function deliverExternalToOwner(owner: string, body: string): Promise<boolean> {
  const { deliveryFor } = await import("./ingress.js");
  if (deliveryFor(EXTERNAL_SOURCE, false) !== "mailboxOnly") return false;
  const { matchSession } = await import("../core/session-match.js");
  const { snapshotAllSessions, isClaudeSession } = await import("../transport/sync-facade.js");
  const { getAllPersistentSessionNames, lookupPersistentName } = await import("../core/persistence.js");
  const { depositToSessionMailbox } = await import("../core/state.js");
  const names = getAllPersistentSessionNames();
  const candidates = snapshotAllSessions().map((s) => ({ id: s.id, name: lookupPersistentName(names, s.id, s.aibrokerId) ?? s.name }));
  const hit = matchSession([owner], candidates, { prefer: (s) => (isClaudeSession(s.id) ? 1 : 0) });
  if (!hit || !isClaudeSession(hit.session.id)) return false;
  depositToSessionMailbox(hit.session.id, "whatsapp-external", body);
  return true;
}
