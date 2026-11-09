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

type DeliverFn = (mb: MailboxConfig, body: string) => Promise<{ ok: boolean; detail: string }>;
type LaunchFn = (project: string, message: string, opts: { prefix: string; sessionName: string }) => Promise<{ outcome: string; reason: string }>;

export interface IngressDeps {
  deliver?: DeliverFn;
  dispatch?: LaunchFn;
  notify?: (text: string) => void;
  now?: () => number;
}

const LAUNCH_RETRY_MS = 10 * 60_000;
const inflightLaunch = new Map<string, Promise<boolean>>();
const lastLaunchFailure = new Map<string, number>();

/** For tests. */
export function __resetLaunchState(): void { inflightLaunch.clear(); lastLaunchFailure.clear(); }

/** Deposit text into the owner's session mailbox. Returns true when it was taken. */
const deliverToOwner: DeliverFn = async (mb, body) => {
  const { deliverMachineMessage } = await import("./inbound.js");
  return deliverMachineMessage(`mail-${mb.name}`, mb.owner, body);
};

async function realDispatch(project: string, message: string, opts: { prefix: string; sessionName: string }) {
  const { dispatch } = await import("./dispatch.js");
  return dispatch(project, message, opts);
}

async function realNotify(text: string): Promise<void> {
  const { broadcastText } = await import("../adapters/pailot/gateway.js");
  broadcastText(text);
}

/**
 * Launch the owner session with the mail as its work order, through dispatch().
 * One launch per owner at a time; a failure blocks relaunch for 10 minutes.
 * Returns "launched" (mail consumed as work order), "wait" (another launch
 * finished OK — deliver normally) or "failed".
 */
async function launchOwner(
  mb: MailboxConfig, body: string, subject: string, deps: IngressDeps, opts: { notify?: boolean } = {},
): Promise<"launched" | "wait" | "failed"> {
  const key = mb.owner.toLowerCase();
  const pending = inflightLaunch.get(key);
  if (pending) return (await pending) ? "wait" : "failed";
  const now = (deps.now ?? Date.now)();
  const failedAt = lastLaunchFailure.get(key);
  if (failedAt !== undefined && now - failedAt < LAUNCH_RETRY_MS) return "failed";

  const prefix = `[Mail:${mb.name}]`;
  const message = body.startsWith(prefix) ? body.slice(prefix.length).trimStart() : body;
  const run = (async () => {
    try {
      const r = await (deps.dispatch ?? realDispatch)(mb.project || mb.owner, message, { prefix, sessionName: mb.owner });
      if (r.outcome === "spawned" || r.outcome === "delivered" || r.outcome === "queued") return true;
      log(`mail-ingress: ${mb.name} auto-launch of ${mb.owner} failed: ${r.outcome}: ${r.reason}`);
    } catch (e) {
      log(`mail-ingress: ${mb.name} auto-launch of ${mb.owner} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    lastLaunchFailure.set(key, (deps.now ?? Date.now)());
    return false;
  })();
  inflightLaunch.set(key, run);
  try {
    const ok = await run;
    if (ok && opts.notify !== false) {
      try { await (deps.notify ?? realNotify)(`Started ${mb.owner} for mail ${subject}`); } catch { /* best effort */ }
    }
    return ok ? "launched" : "failed";
  } finally {
    inflightLaunch.delete(key);
  }
}

type Outcome = { action: "accepted" | "rejected" | "duplicate" | "deferred"; reason: string };
interface Prepared { messageId: string; text: string; subject: string; fromAddr: string; date: number }

/** Parse and gate one message: either a final outcome (rejected/duplicate/deferred) or a deliverable. */
async function prepare(
  mb: MailboxConfig, raw: Buffer, user: string, identity: Identity | undefined, resolver: GateInput["resolver"],
): Promise<{ done: Outcome } | { prep: Prepared }> {
  const { simpleParser } = await import("mailparser");
  const p = await simpleParser(raw);
  const messageId = p.messageId ?? `<noid-${Date.now()}@local>`;
  const fromAddr = p.from?.value?.[0]?.address ?? "";

  if (isAccepted(mb.name, messageId)) return { done: { action: "duplicate", reason: "already accepted" } };

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
    return { done: { action: "deferred", reason: g.reason } };
  }
  if (!g.ok) {
    log(`mail-ingress: ${mb.name} rejected from=${fromAddr || "?"} id=${messageId} reason=${g.reason}`);
    return { done: { action: "rejected", reason: g.reason } };
  }
  const files = await saveAttachments(messageId, p);
  return { prep: { messageId, text: formatMessage(mb, p, messageId, files), subject: p.subject ?? "", fromAddr, date: p.date?.getTime() ?? 0 } };
}

function accepted(mb: MailboxConfig, pr: Prepared, detail: string): Outcome {
  recordAccepted(mb.name, pr.messageId);
  log(`mail-ingress: ${mb.name} accepted from=${pr.fromAddr} id=${pr.messageId} → ${mb.owner}: ${detail}`);
  return { action: "accepted", reason: detail };
}

function deferredOutcome(mb: MailboxConfig, pr: Prepared, detail: string): Outcome {
  log(`mail-ingress: ${mb.name} deferred id=${pr.messageId}: ${detail}`);
  return { action: "deferred", reason: detail };
}

/** Process one fetched message. Returns the action taken. */
export async function handleMessage(
  mb: MailboxConfig, raw: Buffer, user: string, identity?: Identity,
  resolver?: GateInput["resolver"], deps: IngressDeps = {},
): Promise<Outcome> {
  const x = await prepare(mb, raw, user, identity, resolver);
  if ("done" in x) return x.done;
  const pr = x.prep;
  const deliver = deps.deliver ?? deliverToOwner;
  let r = await deliver(mb, pr.text);
  if (!r.ok && mb.autoLaunch !== false && r.detail.startsWith("no live session")) {
    const l = await launchOwner(mb, pr.text, pr.subject, deps);
    if (l === "launched") r = { ok: true, detail: `started ${mb.owner} with the mail as work order` };
    else if (l === "wait") r = await deliver(mb, pr.text);
  }
  return r.ok ? accepted(mb, pr, r.detail) : deferredOutcome(mb, pr, r.detail);
}

/**
 * Catch-up batch: gate every message, sort the accepted ones by IMAP UID (then
 * Date), deliver each as its own [Mail:] message in that order. When the owner
 * has no live session at most one launch happens for the whole batch (the first
 * mail is the work order and names the queued rest). Exactly one PAILot line per
 * batch with N > 1. onResult fires after each mail's own outcome so the caller
 * can flag/move it only once that mail was delivered.
 */
export async function handleBatch(
  mb: MailboxConfig, items: { uid: number; raw: Buffer }[], user: string, identity: Identity | undefined,
  resolver: GateInput["resolver"], deps: IngressDeps,
  onResult: (uid: number, r: Outcome) => Promise<void> | void,
): Promise<void> {
  const queue: { uid: number; pr: Prepared }[] = [];
  for (const it of items) {
    const x = await prepare(mb, it.raw, user, identity, resolver);
    if ("done" in x) await onResult(it.uid, x.done);
    else queue.push({ uid: it.uid, pr: x.prep });
  }
  queue.sort((a, b) => a.uid - b.uid || a.pr.date - b.pr.date);
  const deliver = deps.deliver ?? deliverToOwner;
  let delivered = 0;
  let launched = false;
  let launchTried = false;
  for (let i = 0; i < queue.length; i++) {
    const { uid, pr } = queue[i];
    let r = await deliver(mb, pr.text);
    if (!r.ok && !launchTried && mb.autoLaunch !== false && r.detail.startsWith("no live session")) {
      launchTried = true;
      const rest = queue.slice(i + 1).map((q) => q.pr.messageId);
      const order = rest.length
        ? `${pr.text}\n---\nQueued after this request, delivered next as separate [Mail:${mb.name}] messages in arrival order: ${rest.join(" ")}`
        : pr.text;
      const l = await launchOwner(mb, order, pr.subject, deps, { notify: queue.length === 1 });
      if (l === "launched") { launched = true; r = { ok: true, detail: `started ${mb.owner} with the mail as work order` }; }
      else if (l === "wait") r = await deliver(mb, pr.text);
    }
    const out = r.ok ? accepted(mb, pr, r.detail) : deferredOutcome(mb, pr, r.detail);
    if (r.ok) delivered++;
    await onResult(uid, out);
  }
  if (delivered > 1) {
    try { await (deps.notify ?? realNotify)(`${delivered} requests caught up, session ${mb.owner} ${launched ? "started" : "delivered"}`); } catch { /* best effort */ }
  }
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
      const items: { uid: number; raw: Buffer }[] = [];
      for (const uid of uids || []) {
        const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (msg && msg.source) items.push({ uid: Number(uid), raw: msg.source });
      }
      await handleBatch(mb, items, creds.user, undefined, undefined, {}, async (uid, r) => {
        if (r.action === "deferred") return; // stays UNSEEN, retried by the poll / reconnect
        if (r.action === "rejected") {
          await client.messageMove(String(uid), folders.rejected, { uid: true });
        } else {
          await client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true });
          await client.messageMove(String(uid), folders.accepted, { uid: true });
        }
      });
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
