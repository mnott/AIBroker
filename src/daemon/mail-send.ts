/**
 * daemon/mail-send.ts — the one guarded send function.
 *
 * `sendMail` is called by both `aibroker mail send` and the MCP tool. The
 * rules (mail-core.decideSend) run first and unconditionally; there is no
 * override. Transport and IMAP APPEND are injectable so tests never touch the
 * network. The body and password are never logged.
 */

import { log } from "../core/log.js";
import {
  decideSend, findMailbox, imapEndpoint, loadCredentials, loadIdentity, smtpEndpoint,
  type Credentials, type Identity, type MailboxConfig, type SendInput,
} from "./mail-core.js";

export interface SendDeps {
  mailbox?: MailboxConfig;
  identity?: Identity;
  creds?: Credentials;
  isAccepted?: (mailbox: string, messageId: string) => boolean;
  /** Submit the raw message over SMTP; returns the Message-ID used. */
  transmit?: (creds: Credentials, mb: MailboxConfig, msg: BuiltMessage) => Promise<void>;
  /** Save the raw message to the sent folder via IMAP APPEND. */
  append?: (creds: Credentials, mb: MailboxConfig, raw: Buffer) => Promise<void>;
  /** Look up the mail being answered by Message-ID (accepted folder, then INBOX). */
  findOriginal?: (creds: Credentials, mb: MailboxConfig, messageId: string) => Promise<OriginalMail | undefined>;
}

export interface OriginalMail {
  from: { name?: string; address: string };
  date: Date;
  text: string;
  references?: string;
}

/** Subject with exactly one reply prefix ("Re:"/"AW:" in any case counts as present). */
export function ensureRe(subject: string): string {
  return /^\s*(re|aw)\s*:/i.test(subject) ? subject : `Re: ${subject}`;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** German attribution line plus the original text, every line prefixed with ">" (no space before another ">"). */
export function formatQuote(orig: OriginalMail): string {
  const d = orig.date;
  const who = orig.from.name ? `${orig.from.name} <${orig.from.address}>` : orig.from.address;
  const head = `Am ${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} um ${pad(d.getHours())}:${pad(d.getMinutes())} schrieb ${who}:`;
  const lines = orig.text.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
  return `${head}\n${lines.map((l) => (l.startsWith(">") ? `>${l}` : `> ${l}`)).join("\n")}`;
}

export interface BuiltMessage {
  from: string; to: string[]; cc: string[]; subject: string; text: string;
  messageId: string; inReplyTo?: string; references?: string;
}

export type SendResult = { ok: true; messageId: string; to: string[]; cc: string[]; warning?: string } | { ok: false; error: string };

const bracket = (id: string) => (id.startsWith("<") ? id : `<${id.replace(/^<|>$/g, "")}>`);

export async function sendMail(mailboxName: string, input: SendInput, deps: SendDeps = {}): Promise<SendResult> {
  try {
    const mb = deps.mailbox ?? findMailbox(mailboxName);
    if (!mb) return { ok: false, error: `unknown mailbox "${mailboxName}"` };
    const identity = deps.identity ?? loadIdentity();
    const decision = decideSend(mb, identity, input, deps.isAccepted);
    if (!decision.ok) return { ok: false, error: decision.error };

    const creds = deps.creds ?? loadCredentials(mb.credentialsFile);
    const domain = creds.user.split("@")[1] ?? "localhost";
    const messageId = `<${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}@${domain}>`;
    let text = input.body;
    let references = input.inReplyTo ? bracket(input.inReplyTo) : undefined;
    if (input.inReplyTo && input.quote !== false) {
      try {
        const orig = await (deps.findOriginal ?? findOriginalImap)(creds, mb, bracket(input.inReplyTo));
        if (orig) {
          text = `${input.body}\n\n${formatQuote(orig)}\n`;
          if (orig.references?.trim()) references = `${orig.references.trim()} ${bracket(input.inReplyTo)}`;
        } else {
          log(`mail-send: ${mb.name} original not found, sending without quote`);
        }
      } catch (e) {
        log(`mail-send: ${mb.name} original lookup failed (${e instanceof Error ? e.message : String(e)}), sending without quote`);
      }
    }
    const msg: BuiltMessage = {
      from: `${(mb.displayName ?? mb.name).replace(/["\r\n]/g, "")} <${creds.user}>`,
      to: decision.to, cc: decision.cc,
      subject: input.inReplyTo ? ensureRe(input.subject) : input.subject, text, messageId,
      ...(input.inReplyTo ? { inReplyTo: bracket(input.inReplyTo), references } : {}),
    };

    let raw: Buffer | undefined;
    if (deps.transmit) {
      await deps.transmit(creds, mb, msg);
    } else {
      const nodemailer = await import("nodemailer");
      const transport = nodemailer.createTransport({
        ...smtpEndpoint(creds),
        auth: { user: creds.user, pass: creds.pass },
      });
      const info = await transport.sendMail({
        from: msg.from, to: msg.to, cc: msg.cc, subject: msg.subject, text: msg.text,
        messageId: msg.messageId, inReplyTo: msg.inReplyTo, references: msg.references,
      });
      raw = (info as unknown as { message?: Buffer }).message;
    }
    log(`mail-send: ${mb.name} to=${msg.to.join(",")} cc=${msg.cc.join(",")} id=${messageId} in-reply-to=${msg.inReplyTo ?? "-"}`);

    // Copy to the sent folder. A failure here does not unsend; report it.
    try {
      if (deps.append) await deps.append(creds, mb, raw ?? Buffer.from(msg.text));
      else await appendToSent(creds, mb, msg);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      log(`mail-send: ${mb.name} sent but could not save to sent folder: ${why}`);
      return { ok: true, messageId, to: msg.to, cc: msg.cc, warning: `sent, but the copy could not be saved to the sent folder: ${why}` };
    }
    return { ok: true, messageId, to: msg.to, cc: msg.cc };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Minimal IMAP surface used by saveToSent (lets tests pass a fake). */
export interface SentClient {
  list(): Promise<Array<{ path: string; specialUse?: string }>>;
  mailboxCreate(path: string): Promise<unknown>;
  append(path: string, raw: Buffer, flags: string[]): Promise<unknown>;
}

/** Folder: configured > \\Sent special-use > "Gesendet"; created when missing, then APPEND with \\Seen. */
export async function saveToSent(client: SentClient, mb: MailboxConfig, raw: Buffer): Promise<string> {
  const folders = await client.list();
  let folder = mb.folders?.sent ?? folders.find((f) => f.specialUse === "\\Sent")?.path ?? "Gesendet";
  if (!folders.some((f) => f.path === folder)) await client.mailboxCreate(folder);
  await client.append(folder, raw, ["\\Seen"]);
  return folder;
}

async function appendToSent(creds: Credentials, mb: MailboxConfig, msg: BuiltMessage): Promise<void> {
  const { ImapFlow } = await import("imapflow");
  const MailComposer = (await import("nodemailer/lib/mail-composer/index.js")).default;
  const raw = await new MailComposer({
    from: msg.from, to: msg.to, cc: msg.cc, subject: msg.subject, text: msg.text,
    messageId: msg.messageId, inReplyTo: msg.inReplyTo, references: msg.references, date: new Date(),
  }).compile().build();
  const client = new ImapFlow({ ...imapEndpoint(creds), auth: { user: creds.user, pass: creds.pass }, logger: false });
  await client.connect();
  try {
    await saveToSent(client, mb, raw);
  } finally {
    await client.logout().catch(() => {});
  }
}

async function findOriginalImap(creds: Credentials, mb: MailboxConfig, messageId: string): Promise<OriginalMail | undefined> {
  const { ImapFlow } = await import("imapflow");
  const { simpleParser } = await import("mailparser");
  const client = new ImapFlow({ ...imapEndpoint(creds), auth: { user: creds.user, pass: creds.pass }, logger: false });
  await client.connect();
  try {
    for (const folder of [mb.folders?.accepted ?? "Eingegangen", "INBOX"]) {
      let uid: number | undefined;
      try {
        const lock = await client.getMailboxLock(folder);
        try {
          const hits = await client.search({ header: { "message-id": messageId } }, { uid: true });
          uid = hits && hits.length ? hits[0] : undefined;
          if (uid === undefined) continue;
          const m = await client.fetchOne(String(uid), { source: true }, { uid: true });
          if (!m || !m.source) continue;
          const p = await simpleParser(m.source);
          const f = p.from?.value?.[0];
          if (!f?.address) continue;
          const refs = Array.isArray(p.references) ? p.references.join(" ") : p.references;
          return { from: { name: f.name || undefined, address: f.address }, date: p.date ?? new Date(), text: p.text ?? "", references: refs };
        } finally {
          lock.release();
        }
      } catch {
        continue; // folder missing: try the next one
      }
    }
    return undefined;
  } finally {
    await client.logout().catch(() => {});
  }
}
