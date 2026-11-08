/**
 * daemon/mail-core.ts — config, gate and send rules for the mail ingress.
 *
 * Pure decisions live here (no network): the config loader, the sender gate
 * and the send-rule check. mail-ingress.ts (IMAP) and mail-send.ts (SMTP) are
 * thin I/O around them. Passwords are read here and never logged or returned
 * in an error message.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { DKIMVerifyOptions } from "mailauth";
import { loadJson, saveJson } from "../core/json-store.js";
import { stateDir } from "./owner-rename.js";

// --- config ------------------------------------------------------------------

export interface MailboxConfig {
  name: string;
  credentialsFile: string;
  /** Session / project name that receives accepted mail. Follows `owner rename`. */
  owner: string;
  allowlist: string[];
  includeSelfEmails: boolean;
  /** Mandatory Cc on every outgoing mail of this mailbox; implicitly allowlisted both ways. */
  operatorCc?: string;
  /** Display name for the From header of replies. */
  displayName?: string;
  folders?: { accepted?: string; rejected?: string; sent?: string; drafts?: string };
}

export interface Credentials { user: string; pass: string; imap: string; smtp: string }

export interface Identity { selfEmails: string[]; deliverTo?: string }

export function mailConfigPath(): string {
  return join(stateDir(), "mail-ingress.json");
}

export function loadMailConfig(path = mailConfigPath()): MailboxConfig[] {
  const r = loadJson<{ mailboxes?: MailboxConfig[] }>(path);
  if (r.status !== "ok" || !Array.isArray(r.data?.mailboxes)) return [];
  return r.data.mailboxes.filter((m) => m && m.name && m.owner && m.credentialsFile);
}

export function findMailbox(name: string, path?: string): MailboxConfig | undefined {
  return loadMailConfig(path).find((m) => m.name === name);
}

export function expandHome(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

/** Parses `host[:port]`; throws on an empty host or a non-numeric/out-of-range port. */
export function parseHostPort(value: string, defaultPort: number): { host: string; port: number } {
  const m = /^([^:\s]+)(?::(\d+))?$/.exec(value.trim());
  if (!m) throw new Error(`invalid host[:port] "${value}"`);
  const port = m[2] === undefined ? defaultPort : Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`invalid port in "${value}"`);
  return { host: m[1], port };
}

/** IMAP endpoint: implicit TLS, default port 993. */
export function imapEndpoint(c: Credentials): { host: string; port: number; secure: true } {
  return { ...parseHostPort(c.imap, 993), secure: true };
}

/** SMTP endpoint: port 465 = implicit TLS, otherwise STARTTLS (default 587). */
export function smtpEndpoint(c: Credentials): { host: string; port: number; secure: boolean; requireTLS: boolean } {
  const { host, port } = parseHostPort(c.smtp, 587);
  return { host, port, secure: port === 465, requireTLS: port !== 465 };
}

/** Reads key=value credentials. Refuses a file readable by group/others. */
export function loadCredentials(file: string): Credentials {
  const path = expandHome(file);
  if (!existsSync(path)) throw new Error(`credentials file not found: ${path}`);
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) throw new Error(`credentials file ${path} has mode ${mode.toString(8)}; must be 600 (chmod 600)`);
  const kv: Record<string, string> = {};
  for (const line of readFileSync(path, "utf-8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith("#")) kv[m[1].toLowerCase()] = m[2];
  }
  for (const k of ["user", "pass", "imap", "smtp"]) {
    if (!kv[k]) throw new Error(`credentials file ${path} lacks "${k}"`);
  }
  return { user: kv.user, pass: kv.pass, imap: kv.imap, smtp: kv.smtp };
}

/** identity.deliverTo / identity.selfEmails from ~/.pai/config.yaml (minimal reader). */
export function parseIdentity(yaml: string): Identity {
  const lines = yaml.split(/\r?\n/);
  const start = lines.findIndex((l) => /^identity:\s*$/.test(l));
  if (start < 0) throw new Error("no identity block in PAI config");
  let deliverTo = "";
  const selfEmails: string[] = [];
  let inSelf = false;
  for (const l of lines.slice(start + 1)) {
    if (l.trim() && !/^\s/.test(l)) break; // next top-level key
    const d = /^\s+deliverTo:\s*["']?([^"'\s#]+)/.exec(l);
    if (d) { deliverTo = d[1]; inSelf = false; continue; }
    if (/^\s+selfEmails:\s*$/.test(l)) { inSelf = true; continue; }
    const item = /^\s+-\s*["']?([^"'\s#]+)/.exec(l);
    if (inSelf && item) { selfEmails.push(item[1]); continue; }
    if (/^\s+\S+:/.test(l)) inSelf = false;
  }
  return { selfEmails, ...(deliverTo ? { deliverTo } : {}) };
}

export function loadIdentity(path = join(homedir(), ".pai", "config.yaml")): Identity {
  if (!existsSync(path)) throw new Error(`PAI config not found: ${path}`);
  return parseIdentity(readFileSync(path, "utf-8"));
}

const norm = (a: string) => a.trim().toLowerCase();

/** The allowlist, with operatorCc and (when asked) identity.selfEmails added. */
export function effectiveAllowlist(mb: MailboxConfig, id: Identity): Set<string> {
  const s = new Set(mb.allowlist.map(norm));
  if (mb.includeSelfEmails) for (const e of id.selfEmails) s.add(norm(e));
  if (mb.operatorCc) s.add(norm(mb.operatorCc));
  return s;
}

// --- gate --------------------------------------------------------------------

export interface GateInput {
  /** Every address in the From header; exactly one is accepted. */
  fromAddresses: string[];
  /** To and Cc addresses of the message. */
  to: string[];
  cc: string[];
  /** The mailbox's own address (credentials `user`). */
  mailbox: string;
  /** The raw RFC 822 message, as fetched. */
  raw: Buffer;
  /** DNS resolver override (tests); defaults to live DNS. */
  resolver?: DKIMVerifyOptions["resolver"];
}

export interface GateResult {
  ok: boolean;
  reason: string;
  /** Temporary DNS failure: neither accepted nor rejected, retry on the next cycle. */
  deferred?: boolean;
}

function domainOf(addr: string): string {
  return addr.slice(addr.lastIndexOf("@") + 1).trim().toLowerCase();
}

/**
 * Sender gate. Authentication-Results and Received headers are ignored; the
 * DKIM signatures are verified here against live DNS. Accept iff:
 *  - exactly one From address, on the allowlist;
 *  - a signature passes (header + body hash) with d= aligned to the From
 *    domain and "from" among its signed headers;
 *  - the mailbox's own address is in To or Cc and that signature signs the
 *    matching header (anti-replay to other recipients).
 * A DNS temperror on an aligned signature (and no pass) defers instead of rejecting.
 */
export async function gate(input: GateInput, allowed: Set<string>): Promise<GateResult> {
  if (input.fromAddresses.length !== 1) {
    return { ok: false, reason: input.fromAddresses.length === 0 ? "no From address" : "more than one From address" };
  }
  const from = norm(input.fromAddresses[0]);
  if (!from.includes("@")) return { ok: false, reason: "no From address" };
  if (!allowed.has(from)) return { ok: false, reason: "sender not in allowlist" };

  const fromDomain = domainOf(from);
  const aligned = (d: string) => fromDomain === d || fromDomain.endsWith("." + d) || d.endsWith("." + fromDomain);
  const me = norm(input.mailbox);
  const inTo = input.to.some((a) => norm(a) === me);
  const inCc = input.cc.some((a) => norm(a) === me);
  if (!inTo && !inCc) return { ok: false, reason: "mailbox address not in To/Cc" };

  const { dkimVerify } = await import("mailauth");
  const res = await dkimVerify(input.raw, input.resolver ? { resolver: input.resolver } : {});
  let deferred = false;
  let reason = "no DKIM signature";
  for (const r of res.results ?? []) {
    const d = (r.signingDomain ?? "").toLowerCase();
    const result = r.status?.result;
    if (result === "temperror") {
      if (d && aligned(d)) deferred = true;
      continue;
    }
    if (result !== "pass") { reason = `DKIM ${result ?? "invalid"}`; continue; }
    if (!d || !aligned(d)) { reason = "DKIM d= not aligned with From domain"; continue; }
    const signed = (r.signingHeaders?.keys ?? "").toLowerCase().split(":").map((h) => h.trim());
    if (!signed.includes("from")) { reason = "DKIM signature does not sign From"; continue; }
    if (!(inTo && signed.includes("to")) && !(inCc && signed.includes("cc"))) {
      reason = "DKIM signature does not sign the To/Cc header naming the mailbox";
      continue;
    }
    return { ok: true, reason: `dkim=pass d=${d}` };
  }
  if (deferred) return { ok: false, deferred: true, reason: "DNS temperror verifying DKIM" };
  return { ok: false, reason };
}

// --- accepted / dedupe store ---------------------------------------------------

const MAX_IDS = 5000;
interface AcceptedStore { [mailbox: string]: string[] }

const acceptedFile = () => join(stateDir(), "mail-accepted.json");

export function normMsgId(id: string): string {
  return id.trim().replace(/^<|>$/g, "").toLowerCase();
}

function readAccepted(): AcceptedStore {
  const r = loadJson<AcceptedStore>(acceptedFile());
  return r.status === "ok" && r.data && typeof r.data === "object" ? r.data : {};
}

export function isAccepted(mailbox: string, messageId: string): boolean {
  return (readAccepted()[mailbox] ?? []).includes(normMsgId(messageId));
}

export function recordAccepted(mailbox: string, messageId: string): void {
  const r = loadJson<AcceptedStore>(acceptedFile());
  if (r.status === "unreadable") return; // never overwrite what we cannot parse
  const s = r.status === "ok" && r.data ? r.data : {};
  const list = s[mailbox] ?? [];
  const id = normMsgId(messageId);
  if (!list.includes(id)) list.push(id);
  s[mailbox] = list.slice(-MAX_IDS);
  saveJson(acceptedFile(), s);
}

// --- send rules ----------------------------------------------------------------

export interface SendInput {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  inReplyTo?: string;
}

export type SendDecision =
  | { ok: true; to: string[]; cc: string[] }
  | { ok: false; error: string };

/**
 * The send rules, unconditional:
 *  a. every To/Cc must be on the mailbox allowlist or in selfEmails;
 *  b. if any recipient is not a selfEmail, inReplyTo is mandatory and must be
 *     a message-id this mailbox's ingress accepted;
 *  c. the mailbox's operatorCc is always added as Cc (refused when unset).
 *     It counts as self for rule b. No Bcc exists.
 */
export function decideSend(
  mb: MailboxConfig,
  id: Identity,
  input: SendInput,
  isAcceptedId: (mailbox: string, messageId: string) => boolean = isAccepted,
): SendDecision {
  if (!mb.operatorCc || !norm(mb.operatorCc).includes("@")) {
    return { ok: false, error: `refused: mailbox "${mb.name}" has no operatorCc configured` };
  }
  const to = (input.to ?? []).map(norm).filter(Boolean);
  const cc = (input.cc ?? []).map(norm).filter(Boolean);
  if (to.length === 0) return { ok: false, error: "refused: no To recipient" };
  const self = new Set(id.selfEmails.map(norm));
  self.add(norm(mb.operatorCc));
  const allowed = effectiveAllowlist({ ...mb, includeSelfEmails: true }, id);
  for (const r of [...to, ...cc]) {
    if (!allowed.has(r)) return { ok: false, error: `refused: recipient ${r} is not on the allowlist for mailbox "${mb.name}"` };
  }
  const external = [...to, ...cc].filter((r) => !self.has(r));
  if (external.length > 0) {
    if (!input.inReplyTo) {
      return { ok: false, error: "refused: mail to a non-self recipient must be a reply (--in-reply-to) to an accepted change request" };
    }
    if (!isAcceptedId(mb.name, input.inReplyTo)) {
      return { ok: false, error: "refused: in-reply-to is not a message this mailbox accepted via ingress" };
    }
  }
  const deliver = norm(mb.operatorCc);
  const ccOut = [...new Set([...cc, deliver])].filter((a) => !to.includes(a));
  return { ok: true, to: [...new Set(to)], cc: ccOut };
}
