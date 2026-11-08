/**
 * daemon/mail-ingress.ts — IMAP IDLE ingress, one connection per mailbox.
 *
 * Config: ~/.aibroker/mail-ingress.json (see README "Mail ingress"). On every
 * (re)connect all UNSEEN INBOX messages are fetched (catch-up after the laptop
 * slept), then IDLE pushes new ones. Each message passes mail-core.gate; a
 * failure moves it to the rejected folder with one log line and NOTHING else:
 * no reply, bounce, auto-reply or read receipt (Disposition-Notification-To is
 * ignored); this module never sends mail. An accepted message is deposited in the owner session's mailbox like
 * other machine ingress; only after a successful deposit is it marked \Seen
 * and moved, so a session that is not running leaves it UNSEEN and it is
 * retried (periodically and at the next reconnect). Deduped by message-id.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../core/log.js";
import { stateDir } from "./owner-rename.js";
import {
  effectiveAllowlist, findMailbox, gate, type GateInput, imapEndpoint, isAccepted, loadCredentials, loadIdentity,
  loadMailConfig, normMsgId, recordAccepted, type Credentials, type Identity, type MailboxConfig,
} from "./mail-core.js";

const RETRY_POLL_MS = 5 * 60_000;
const BACKOFF_MIN = 5_000;
const BACKOFF_MAX = 5 * 60_000;

export function sanitizeId(id: string): string {
  return normMsgId(id).replace(/[^\w.@-]+/g, "_").replace(/^\.+/, "_").slice(0, 120) || "unknown";
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

type Parsed = import("mailparser").ParsedMail;

function formatMessage(mb: MailboxConfig, p: Parsed, messageId: string, files: string[]): string {
  const from = p.from?.text ?? "";
  const refs = Array.isArray(p.references) ? p.references.join(" ") : (p.references ?? "");
  const body = (p.text && p.text.trim()) || (p.html ? htmlToText(String(p.html)) : "");
  return [
    `[Mail:${mb.name}] change request received`,
    `From: ${from}`,
    `Subject: ${p.subject ?? ""}`,
    `Date: ${p.date?.toISOString() ?? ""}`,
    `Message-ID: ${messageId}`,
    `In-Reply-To: ${p.inReplyTo ?? ""}`,
    `References: ${refs}`,
    files.length ? `Attachments:\n${files.map((f) => `  - ${f}`).join("\n")}` : "Attachments: none",
    `Reply only via: aibroker mail send --mailbox ${mb.name} --in-reply-to '${messageId}' ...`,
    "---",
    body,
  ].join("\n");
}

async function saveAttachments(messageId: string, p: Parsed): Promise<string[]> {
  if (!p.attachments?.length) return [];
  const dir = join(stateDir(), "mail-attachments", sanitizeId(messageId));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const out: string[] = [];
  let n = 0;
  for (const a of p.attachments) {
    const base = (a.filename ?? `attachment-${n}`).replace(/[^\w.-]+/g, "_").replace(/^\.+/, "_").slice(0, 100) || `attachment-${n}`;
    const path = join(dir, `${n++}-${base}`);
    writeFileSync(path, a.content, { mode: 0o600 });
    out.push(path);
  }
  return out;
}

/** Deposit text into the owner's session mailbox. Returns true when it was taken. */
async function deliverToOwner(mb: MailboxConfig, body: string): Promise<{ ok: boolean; detail: string }> {
  const { deliverMachineMessage } = await import("./inbound.js");
  return deliverMachineMessage(`mail-${mb.name}`, mb.owner, body);
}

/** Process one fetched message. Returns the action taken. */
export async function handleMessage(
  mb: MailboxConfig, raw: Buffer, user: string, identity?: Identity,
  resolver?: GateInput["resolver"],
): Promise<{ action: "accepted" | "rejected" | "duplicate" | "deferred"; reason: string }> {
  const { simpleParser } = await import("mailparser");
  const p = await simpleParser(raw);
  const messageId = p.messageId ?? `<noid-${Date.now()}@local>`;
  const fromAddr = p.from?.value?.[0]?.address ?? "";

  if (isAccepted(mb.name, messageId)) return { action: "duplicate", reason: "already accepted" };

  const addrs = (v: unknown): string[] => {
    const list = Array.isArray(v) ? v : v ? [v] : [];
    return list.flatMap((x: { value?: { address?: string }[] }) => (x.value ?? []).map((a) => a.address ?? "")).filter(Boolean);
  };
  const g = await gate(
    { fromAddresses: addrs(p.from), to: addrs(p.to), cc: addrs(p.cc), mailbox: user, raw, resolver },
    effectiveAllowlist(mb, identity ?? loadIdentity()),
  );
  if (g.deferred) {
    log(`mail-ingress: ${mb.name} deferred id=${messageId} reason=${g.reason}`);
    return { action: "deferred", reason: g.reason };
  }
  if (!g.ok) {
    log(`mail-ingress: ${mb.name} rejected from=${fromAddr || "?"} id=${messageId} reason=${g.reason}`);
    return { action: "rejected", reason: g.reason };
  }

  const files = await saveAttachments(messageId, p);
  const r = await deliverToOwner(mb, formatMessage(mb, p, messageId, files));
  if (!r.ok) {
    log(`mail-ingress: ${mb.name} deferred id=${messageId}: ${r.detail}`);
    return { action: "deferred", reason: r.detail };
  }
  recordAccepted(mb.name, messageId);
  log(`mail-ingress: ${mb.name} accepted from=${fromAddr} id=${messageId} → ${mb.owner}: ${r.detail}`);
  return { action: "accepted", reason: r.detail };
}

async function runMailbox(name: string, signal: { stopped: boolean }): Promise<void> {
  let backoff = BACKOFF_MIN;
  while (!signal.stopped) {
    // Re-read config each cycle: `owner rename` and edits apply on reconnect.
    const mb = findMailbox(name);
    if (!mb) { log(`mail-ingress: ${name} no longer configured — stopping`); return; }
    try {
      const creds = loadCredentials(mb.credentialsFile);
      await session(mb, creds, signal);
      backoff = BACKOFF_MIN;
    } catch (e) {
      // Never include creds in messages: imapflow errors carry the server text only.
      log(`mail-ingress: ${name} connection error: ${e instanceof Error ? e.message : String(e)} — retry in ${Math.round(backoff / 1000)}s`);
    }
    if (signal.stopped) return;
    await new Promise((r) => setTimeout(r, backoff).unref?.());
    backoff = Math.min(backoff * 2, BACKOFF_MAX);
  }
}

async function session(mb0: MailboxConfig, creds: Credentials, signal: { stopped: boolean }): Promise<void> {
  const { ImapFlow } = await import("imapflow");
  const client = new ImapFlow({
    ...imapEndpoint(creds),
    auth: { user: creds.user, pass: creds.pass }, logger: false,
  });
  let closed!: () => void;
  const closedP = new Promise<void>((r) => { closed = r; });
  client.on("close", () => closed());
  client.on("error", (e: Error) => log(`mail-ingress: ${mb0.name} imap error: ${e.message}`));

  await client.connect();
  const folders = {
    accepted: mb0.folders?.accepted ?? "Eingegangen",
    rejected: mb0.folders?.rejected ?? "Abgelehnt",
  };
  for (const f of [folders.accepted, folders.rejected]) await client.mailboxCreate(f).catch(() => {});
  await client.mailboxOpen("INBOX");
  log(`mail-ingress: ${mb0.name} connected, IDLE`);

  let chain: Promise<void> = Promise.resolve();
  const sweep = () => {
    chain = chain.then(async () => {
      const mb = findMailbox(mb0.name) ?? mb0;
      const uids = await client.search({ seen: false }, { uid: true });
      for (const uid of uids || []) {
        const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (!msg || !msg.source) continue;
        const r = await handleMessage(mb, msg.source, creds.user);
        if (r.action === "deferred") continue; // stays UNSEEN, retried by the poll / reconnect
        if (r.action === "rejected") {
          await client.messageMove(String(uid), folders.rejected, { uid: true });
        } else {
          await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
          await client.messageMove(String(uid), folders.accepted, { uid: true });
        }
      }
    }).catch((e) => log(`mail-ingress: ${mb0.name} sweep failed: ${e instanceof Error ? e.message : String(e)}`));
    return chain;
  };

  client.on("exists", () => { void sweep(); });
  await sweep(); // catch-up
  const poll = setInterval(() => { void sweep(); }, RETRY_POLL_MS);
  poll.unref?.();
  const stopWatch = setInterval(() => { if (signal.stopped) void client.logout().catch(() => {}); }, 5000);
  stopWatch.unref?.();
  try { await closedP; } finally { clearInterval(poll); clearInterval(stopWatch); }
}

/** Start one IDLE loop per configured mailbox. Returns a stop function. */
export function startMailIngress(): () => void {
  const signal = { stopped: false };
  const boxes = loadMailConfig();
  if (boxes.length === 0) return () => {};
  for (const mb of boxes) {
    log(`mail-ingress: starting ${mb.name} → ${mb.owner}`);
    void runMailbox(mb.name, signal);
  }
  return () => { signal.stopped = true; };
}
