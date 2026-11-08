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
}

export interface BuiltMessage {
  from: string; to: string[]; cc: string[]; subject: string; text: string;
  messageId: string; inReplyTo?: string; references?: string;
}

export type SendResult = { ok: true; messageId: string; to: string[]; cc: string[] } | { ok: false; error: string };

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
    const msg: BuiltMessage = {
      from: `${(mb.displayName ?? mb.name).replace(/["\r\n]/g, "")} <${creds.user}>`,
      to: decision.to, cc: decision.cc,
      subject: input.subject, text: input.body, messageId,
      ...(input.inReplyTo ? { inReplyTo: bracket(input.inReplyTo), references: bracket(input.inReplyTo) } : {}),
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
      log(`mail-send: ${mb.name} sent but could not save to sent folder: ${e instanceof Error ? e.message : String(e)}`);
      return { ok: true, messageId, to: msg.to, cc: msg.cc };
    }
    return { ok: true, messageId, to: msg.to, cc: msg.cc };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
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
    let folder = mb.folders?.sent ?? "Gesendet";
    if (!mb.folders?.sent) {
      const hit = (await client.list()).find((f) => f.specialUse === "\\Sent");
      if (hit) folder = hit.path;
    }
    await client.append(folder, raw, ["\\Seen"]);
  } finally {
    await client.logout().catch(() => {});
  }
}
