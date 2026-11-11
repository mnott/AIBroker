import "./home-guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  gate, effectiveAllowlist, decideSend, loadCredentials, parseIdentity,
  parseHostPort, imapEndpoint, smtpEndpoint,
  type MailboxConfig, type Identity,
} from "../src/daemon/mail-core.js";
import { sendMail, saveToSent, formatQuote, ensureRe, type OriginalMail, type BuiltMessage } from "../src/daemon/mail-send.js";
import { readFileSync } from "node:fs";
import { handleMessage } from "../src/daemon/mail-ingress.js";
import { generateKeyPairSync } from "node:crypto";
import { dkimSign } from "mailauth";
import { renameOwner } from "../src/daemon/owner-rename.js";

const mb: MailboxConfig = {
  name: "site", credentialsFile: "x", owner: "Site Owner", includeSelfEmails: true,
  allowlist: ["Requester@Example.org"], operatorCc: "operator@example.org",
};
const id: Identity = { selfEmails: ["me@example.org"] };
const allowed = effectiveAllowlist(mb, id);
const HOST = "imap.example.org";
const BOX = "box@example.org";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pubB64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
const goodResolver = async (name: string, rr: string) => {
  assert.equal(rr, "TXT");
  if (name === "s1._domainkey.example.org" || name === "s1._domainkey.other.org") return [[`v=DKIM1; k=rsa; p=${pubB64}`]];
  throw Object.assign(new Error("nx"), { code: "ENOTFOUND" });
};
const tempResolver = async () => { throw Object.assign(new Error("timeout"), { code: "ETIMEOUT" }); };

function msg(o: { from?: string; to?: string; cc?: string } = {}): string {
  return [
    `From: Requester <${o.from ?? "requester@example.org"}>`, `To: ${o.to ?? BOX}`, ...(o.cc ? [`Cc: ${o.cc}`] : []),
    "Subject: change", "Message-ID: <m1@example.org>", "Date: Sun, 08 Nov 2026 10:00:00 +0000", "", "please change the page", "",
  ].join("\r\n");
}
async function signed(text: string, domain = "example.org", headerList = "from:to:cc:subject:message-id:date"): Promise<Buffer> {
  const r = await dkimSign(text, { canonicalization: "relaxed/relaxed", headerList, signatureData: [{ signingDomain: domain, selector: "s1", privateKey: privateKey.export({ type: "pkcs8", format: "pem" }) as string, algorithm: "rsa-sha256" }] });
  assert.equal(r.errors.length, 0);
  return Buffer.from(r.signatures + text);
}
const g = async (raw: Buffer, o: { from?: string[]; to?: string[]; cc?: string[]; resolver?: typeof goodResolver } = {}) =>
  gate({ fromAddresses: o.from ?? ["requester@example.org"], to: o.to ?? [BOX], cc: o.cc ?? [], mailbox: BOX, raw, resolver: o.resolver ?? goodResolver }, allowed);

test("gate: signed d=example.org, From allowlisted, mailbox in To -> accept", async () => {
  const r = await g(await signed(msg()));
  assert.equal(r.ok, true, r.reason);
  assert.equal((await g(await signed(msg()), { from: ["REQUESTER@EXAMPLE.ORG"] })).ok, true); // allowlist case-insensitive
});

test("gate: unsigned -> reject", async () => {
  const r = await g(Buffer.from(msg()));
  assert.equal(r.ok, false);
  assert.equal(r.deferred, undefined);
});

test("gate: misaligned d=other.org -> reject", async () => {
  const r = await g(await signed(msg(), "other.org"));
  assert.equal(r.ok, false);
  assert.match(r.reason, /not aligned/);
});

test("gate: body altered after signing -> reject", async () => {
  const raw = (await signed(msg())).toString().replace("please change", "please DELETE");
  const r = await g(Buffer.from(raw));
  assert.equal(r.ok, false);
  assert.equal(r.deferred, undefined);
});

test("gate: valid signature but mailbox address not in To/Cc -> reject", async () => {
  const raw = await signed(msg({ to: "someone@example.net" }));
  const r = await g(raw, { to: ["someone@example.net"] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /not in To\/Cc/);
});

test("gate: signature not covering To (replay) -> reject; Cc covered -> accept", async () => {
  const noTo = await signed(msg(), "example.org", "from:subject:message-id:date");
  assert.equal((await g(noTo)).ok, false);
  const ccMsg = msg({ to: "someone@example.net", cc: BOX });
  assert.equal((await g(await signed(ccMsg), { to: ["someone@example.net"], cc: [BOX] })).ok, true);
});

test("gate: From not on allowlist, even with valid DKIM -> reject; two From addresses -> reject", async () => {
  const raw = await signed(msg({ from: "stranger@example.org" }));
  const r = await g(raw, { from: ["stranger@example.org"] });
  assert.equal(r.reason, "sender not in allowlist");
  assert.equal((await g(await signed(msg()), { from: ["requester@example.org", "me@example.org"] })).ok, false);
});

test("gate: Authentication-Results header is ignored", async () => {
  const raw = Buffer.from("Authentication-Results: mx.example.org; dkim=pass header.d=example.org; dmarc=pass header.from=example.org\r\n" + msg());
  assert.equal((await g(raw)).ok, false);
});

test("gate: DNS temperror -> deferred, not rejected", async () => {
  const raw = await signed(msg());
  const r = await g(raw, { resolver: tempResolver });
  assert.equal(r.ok, false);
  assert.equal(r.deferred, true);
  const h = await handleMessage(mb, raw, BOX, id, tempResolver);
  assert.equal(h.action, "deferred");
});

const creds = { user: "box@example.org", pass: "p", imap: HOST, smtp: "smtp.example.org" };

test("send rules: refuse non-allowlisted recipient, nothing transmitted or saved", async () => {
  let touched = 0;
  const r = await sendMail("site", { to: ["rando@example.net"], subject: "s", body: "b", inReplyTo: "<a@x>" },
    { mailbox: mb, identity: id, creds, isAccepted: () => true, transmit: async () => { touched++; }, append: async () => { touched++; } });
  assert.equal(r.ok, false);
  assert.equal(touched, 0);
  assert.equal(decideSend(mb, id, { to: ["me@example.org"], cc: ["rando@example.net"], subject: "s", body: "b" }).ok, false);
});

test("send rules: non-self recipient needs an accepted in-reply-to", () => {
  assert.equal(decideSend(mb, id, { to: ["requester@example.org"], subject: "s", body: "b" }, () => true).ok, false);
  assert.equal(decideSend(mb, id, { to: ["requester@example.org"], subject: "s", body: "b", inReplyTo: "<nope@x>" }, () => false).ok, false);
  const ok = decideSend(mb, id, { to: ["requester@example.org"], subject: "s", body: "b", inReplyTo: "<a@x>" }, (m, i) => m === "site" && i === "<a@x>");
  assert.equal(ok.ok, true);
  assert.equal(decideSend(mb, id, { to: ["me@example.org"], subject: "s", body: "b" }, () => false).ok, true); // self-only
});

test("send rules: operatorCc always Cc'd; refused when unset; sent then saved", async () => {
  const calls: string[] = [];
  const r = await sendMail("site", { to: ["requester@example.org"], subject: "s", body: "b", inReplyTo: "a@x" },
    { mailbox: mb, identity: id, creds, isAccepted: () => true, findOriginal: async () => undefined,
      transmit: async (_c, _m, msg) => { calls.push(`tx cc=${msg.cc.join(",")} irt=${msg.inReplyTo}`); },
      append: async () => { calls.push("append"); } });
  assert.equal(r.ok, true);
  assert.deepEqual(calls, ["tx cc=operator@example.org irt=<a@x>", "append"]);
  assert.equal(decideSend({ ...mb, operatorCc: undefined }, id, { to: ["me@example.org"], subject: "s", body: "b" }).ok, false);
});

// --- reply quoting ---------------------------------------------------------
const orig: OriginalMail = {
  from: { name: "Example Requester", address: "requester@example.org" },
  date: new Date(2026, 10, 9, 8, 5), text: "Hallo\n> frueher\n\nBitte aendern\n", references: "<r0@x>",
};

async function sendQuoted(extra: { quote?: boolean; subject?: string; find?: () => Promise<OriginalMail | undefined> }) {
  const sent: BuiltMessage[] = [];
  let lookups = 0;
  const r = await sendMail("site", { to: ["requester@example.org"], subject: extra.subject ?? "Aenderung", body: "Erledigt.", inReplyTo: "a@x", quote: extra.quote },
    { mailbox: mb, identity: id, creds, isAccepted: () => true,
      findOriginal: async () => { lookups++; return extra.find ? extra.find() : orig; },
      transmit: async (_c, _m, m) => { sent.push(m); }, append: async () => {} });
  assert.equal(r.ok, true);
  return { msg: sent[0], lookups };
}

test("quote: attribution, prefixed lines, nested >>, References extended", async () => {
  assert.equal(formatQuote(orig), "Am 09.11.2026 um 08:05 schrieb Example Requester <requester@example.org>:\n> Hallo\n>> frueher\n> \n> Bitte aendern");
  const { msg, lookups } = await sendQuoted({});
  assert.equal(lookups, 1);
  assert.match(msg.text, /^Erledigt\.\n\nAm 09\.11\.2026 um 08:05 schrieb Example Requester <requester@example\.org>:\n> Hallo\n>> frueher/);
  assert.equal(msg.references, "<r0@x> <a@x>");
  assert.equal(msg.inReplyTo, "<a@x>");
});

test("quote: original not found or lookup failure sends without quote", async () => {
  for (const find of [async () => undefined, async () => { throw new Error("imap down"); }]) {
    const { msg } = await sendQuoted({ find });
    assert.equal(msg.text, "Erledigt.");
    assert.equal(msg.references, "<a@x>");
  }
});

test("quote: quote:false sends without lookup", async () => {
  const { msg, lookups } = await sendQuoted({ quote: false });
  assert.equal(lookups, 0);
  assert.equal(msg.text, "Erledigt.");
});

test("quote: subject has exactly one Re: prefix", async () => {
  assert.equal(ensureRe("Aenderung"), "Re: Aenderung");
  for (const s of ["Re: x", "RE: x", "re:x", "AW: x", "aw: x"]) assert.equal(ensureRe(s), s);
  assert.equal((await sendQuoted({ subject: "Re: Aenderung" })).msg.subject, "Re: Aenderung");
  assert.equal((await sendQuoted({ subject: "Aenderung" })).msg.subject, "Re: Aenderung");
});

test("credentials file must be mode 600; password never appears in the error", () => {
  const dir = mkdtempSync(join(tmpdir(), "aibroker-mail-"));
  const f = join(dir, "cred");
  writeFileSync(f, "user=box@example.org\npass=hunter2-secret\nimap=imap.example.org\nsmtp=smtp.example.org\n");
  chmodSync(f, 0o644);
  assert.throws(() => loadCredentials(f), (e: Error) => /600/.test(e.message) && !e.message.includes("hunter2"));
  chmodSync(f, 0o600);
  assert.equal(loadCredentials(f).user, "box@example.org");
});

test("identity parsing and owner rename covers mail-ingress.json", () => {
  const i = parseIdentity("a: 1\nidentity:\n  deliverTo: me@example.org\n  selfEmails:\n    - me@example.org\n    - alt@example.org\nother: x\n");
  assert.deepEqual(i.selfEmails, ["me@example.org", "alt@example.org"]);
  const dir = mkdtempSync(join(tmpdir(), "aibroker-mailren-"));
  writeFileSync(join(dir, "mail-ingress.json"), JSON.stringify({ mailboxes: [{ name: "site", owner: "Old" }, { name: "b", owner: "Other" }] }));
  const rep = renameOwner(dir, "Old", "New", false);
  assert.deepEqual(rep.changes.map((c) => c.file), ["mail-ingress.json"]);
});

test("rejected mail is silent: handleMessage only reports rejected, ingress module has no send path", async () => {
  const raw = Buffer.from([
    "From: Requester <requester@example.org>", "To: box@example.org",
    "Disposition-Notification-To: requester@example.org", "Subject: x", "Message-ID: <rej1@example.org>", "",
    "body", "",
  ].join("\r\n"));
  const r = await handleMessage(mb, raw, BOX, id, goodResolver);
  assert.equal(r.action, "rejected");
  const src = readFileSync(new URL("../src/daemon/mail-ingress.ts", import.meta.url), "utf-8");
  assert.doesNotMatch(src, /mail-send|nodemailer|sendMail|createTransport|smtp\b/);
});

test("host[:port] parsing: defaults, explicit port, invalid port, smtp TLS mode", () => {
  assert.deepEqual(parseHostPort("imap.example.org", 993), { host: "imap.example.org", port: 993 });
  assert.deepEqual(parseHostPort("imap.example.org:1993", 993), { host: "imap.example.org", port: 1993 });
  for (const bad of ["imap.example.org:abc", "imap.example.org:0", "imap.example.org:70000", "imap.example.org:", ":993", ""]) {
    assert.throws(() => parseHostPort(bad, 993), /invalid/, bad);
  }
  const c = { user: "u", pass: "p", imap: "imap.example.org:993", smtp: "smtp.example.org" };
  assert.deepEqual(imapEndpoint(c), { host: "imap.example.org", port: 993, secure: true });
  assert.deepEqual(smtpEndpoint(c), { host: "smtp.example.org", port: 587, secure: false, requireTLS: true });
  assert.deepEqual(smtpEndpoint({ ...c, smtp: "smtp.example.org:465" }), { host: "smtp.example.org", port: 465, secure: true, requireTLS: false });
  assert.deepEqual(smtpEndpoint({ ...c, smtp: "smtp.example.org:2525" }), { host: "smtp.example.org", port: 2525, secure: false, requireTLS: true });
});

// --- auto-launch of the owner session ---------------------------------------
import { __resetLaunchState } from "../src/daemon/mail-ingress.js";

async function mailWith(mid: string): Promise<Buffer> {
  return signed(msg().replace("<m1@example.org>", `<${mid}@example.org>`));
}
const NO_SESSION = { ok: false, detail: 'no live session matches owner "Site Owner"' };

function harness(deliverResults: { ok: boolean; detail: string }[], dispatchImpl?: () => Promise<{ outcome: string; reason: string }>) {
  __resetLaunchState();
  const calls = { dispatch: [] as { project: string; message: string; prefix: string; sessionName: string }[], deliver: 0, notify: [] as string[] };
  let clock = 1_000_000;
  const deps = {
    deliver: async () => deliverResults[Math.min(calls.deliver++, deliverResults.length - 1)],
    dispatch: async (project: string, message: string, o: { prefix: string; sessionName: string }) => {
      calls.dispatch.push({ project, message, ...o });
      return dispatchImpl ? dispatchImpl() : { outcome: "spawned", reason: "" };
    },
    notify: (t: string) => { calls.notify.push(t); },
    now: () => clock,
  };
  return { calls, deps, advance: (ms: number) => { clock += ms; } };
}

test("auto-launch: owner not running -> dispatch once with owner name and [Mail:] prefix, accepted, operator notified", async () => {
  const h = harness([NO_SESSION]);
  const r = await handleMessage({ ...mb, project: "example-project" }, await mailWith("al1"), BOX, id, goodResolver, h.deps);
  assert.equal(r.action, "accepted");
  assert.equal(h.calls.dispatch.length, 1);
  assert.equal(h.calls.dispatch[0].sessionName, "Site Owner");
  assert.equal(h.calls.dispatch[0].project, "example-project");
  assert.equal(h.calls.dispatch[0].prefix, "[Mail:site]");
  assert.match(h.calls.dispatch[0].message, /^change request received/);
  assert.deepEqual(h.calls.notify, ["Started Site Owner for mail change"]);
});

test("auto-launch: without project the owner name is the project", async () => {
  const h = harness([NO_SESSION]);
  await handleMessage(mb, await mailWith("al1b"), BOX, id, goodResolver, h.deps);
  assert.equal(h.calls.dispatch[0].project, "Site Owner");
});

test("auto-launch: owner running -> no dispatch", async () => {
  const h = harness([{ ok: true, detail: "delivered" }]);
  const r = await handleMessage(mb, await mailWith("al2"), BOX, id, goodResolver, h.deps);
  assert.equal(r.action, "accepted");
  assert.equal(h.calls.dispatch.length, 0);
  assert.equal(h.calls.notify.length, 0);
});

test("auto-launch: two mails during launch -> one dispatch, second delivered normally", async () => {
  let release!: () => void;
  const gateP = new Promise<void>((res) => { release = res; });
  const h = harness([NO_SESSION, NO_SESSION, { ok: true, detail: "delivered" }], async () => { await gateP; return { outcome: "spawned", reason: "" }; });
  const a = handleMessage(mb, await mailWith("al3a"), BOX, id, goodResolver, h.deps);
  const b = handleMessage(mb, await mailWith("al3b"), BOX, id, goodResolver, h.deps);
  await new Promise((r) => setTimeout(r, 20));
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.action, "accepted");
  assert.equal(rb.action, "accepted");
  assert.equal(h.calls.dispatch.length, 1);
  assert.equal(h.calls.notify.length, 1);
});

test("auto-launch: autoLaunch false -> deferred, no dispatch", async () => {
  const h = harness([NO_SESSION]);
  const r = await handleMessage({ ...mb, autoLaunch: false }, await mailWith("al4"), BOX, id, goodResolver, h.deps);
  assert.equal(r.action, "deferred");
  assert.equal(h.calls.dispatch.length, 0);
});

test("auto-launch: failure -> deferred, relaunch only after 10 minutes", async () => {
  const h = harness([NO_SESSION], async () => ({ outcome: "unreachable", reason: "boom" }));
  const m = await mailWith("al5");
  assert.equal((await handleMessage(mb, m, BOX, id, goodResolver, h.deps)).action, "deferred");
  assert.equal(h.calls.dispatch.length, 1);
  h.advance(5 * 60_000);
  assert.equal((await handleMessage(mb, m, BOX, id, goodResolver, h.deps)).action, "deferred");
  assert.equal(h.calls.dispatch.length, 1);
  h.advance(6 * 60_000);
  assert.equal((await handleMessage(mb, m, BOX, id, goodResolver, h.deps)).action, "deferred");
  assert.equal(h.calls.dispatch.length, 2);
  assert.equal(h.calls.notify.length, 0);
});

test("auto-launch: shell prompt (not absence) never launches", async () => {
  const h = harness([{ ok: false, detail: 'session "x" is at a shell prompt, not a Claude prompt' }]);
  const r = await handleMessage(mb, await mailWith("al6"), BOX, id, goodResolver, h.deps);
  assert.equal(r.action, "deferred");
  assert.equal(h.calls.dispatch.length, 0);
});

// --- catch-up batch ----------------------------------------------------------
import { handleBatch } from "../src/daemon/mail-ingress.js";

function batchHarness(running: boolean) {
  __resetLaunchState();
  let live = running;
  const calls = { dispatch: 0, delivered: [] as string[], notify: [] as string[] };
  const deps = {
    deliver: async (_m: MailboxConfig, body: string) => {
      if (!live) return NO_SESSION;
      calls.delivered.push(body);
      return { ok: true, detail: "delivered" };
    },
    dispatch: async (_p: string, message: string) => {
      calls.dispatch++;
      live = true;
      calls.delivered.push(`[work order] ${message}`);
      return { outcome: "spawned", reason: "" };
    },
    notify: (t: string) => { calls.notify.push(t); },
    now: () => 1_000_000,
  };
  return { calls, deps };
}
const runBatch = async (h: ReturnType<typeof batchHarness>, items: { uid: number; mid: string }[]) => {
  const raws = await Promise.all(items.map(async (i) => ({ uid: i.uid, raw: await mailWith(i.mid) })));
  const results: [number, string][] = [];
  await handleBatch(mb, raws, BOX, id, goodResolver, h.deps, (uid, r) => { results.push([uid, r.action]); });
  return results;
};
const midsOf = (texts: string[]) => texts.map((t) => /Message-ID: <(\w+)@example.org>/.exec(t)?.[1]);

test("batch: 2 queued, owner not running -> one dispatch, both delivered in UID order, one notification", async () => {
  const h = batchHarness(false);
  const res = await runBatch(h, [{ uid: 11, mid: "b2" }, { uid: 10, mid: "b1" }]);
  assert.equal(h.calls.dispatch, 1);
  assert.deepEqual(midsOf(h.calls.delivered), ["b1", "b2"]);
  assert.match(h.calls.delivered[0], /^\[work order\]/);
  assert.match(h.calls.delivered[0], /b2@example\.org/); // work order names the queued rest
  assert.deepEqual(res, [[10, "accepted"], [11, "accepted"]]);
  assert.deepEqual(h.calls.notify, ["2 requests caught up, session Site Owner started"]);
});

test("batch: thread headers present in delivered text", async () => {
  const h = batchHarness(true);
  await runBatch(h, [{ uid: 1, mid: "t1" }, { uid: 2, mid: "t2" }]);
  for (const t of h.calls.delivered) {
    assert.match(t, /^\[Mail:site\]/);
    assert.match(t, /^Message-ID: <t\d@example\.org>$/m);
    assert.match(t, /^In-Reply-To: /m);
    assert.match(t, /^References: /m);
  }
});

test("batch: owner running + 3 queued -> no dispatch, 3 deliveries in order, one notification", async () => {
  const h = batchHarness(true);
  const res = await runBatch(h, [{ uid: 32, mid: "r3" }, { uid: 30, mid: "r1" }, { uid: 31, mid: "r2" }]);
  assert.equal(h.calls.dispatch, 0);
  assert.deepEqual(midsOf(h.calls.delivered), ["r1", "r2", "r3"]);
  assert.deepEqual(res.map((r) => r[0]), [30, 31, 32]);
  assert.deepEqual(h.calls.notify, ["3 requests caught up, session Site Owner delivered"]);
});

test("batch: single mail while running -> no notification; failed delivery stays unflagged", async () => {
  const h = batchHarness(true);
  await runBatch(h, [{ uid: 5, mid: "s1" }]);
  assert.equal(h.calls.notify.length, 0);
  const f = batchHarness(false);
  const res = await runBatch({ ...f, deps: { ...f.deps, dispatch: async () => ({ outcome: "unreachable", reason: "x" }) } }, [{ uid: 1, mid: "f1" }, { uid: 2, mid: "f2" }]);
  assert.deepEqual(res, [[1, "deferred"], [2, "deferred"]]);
  assert.equal(f.calls.notify.length, 0);
});

function fakeSentClient(folders: Array<{ path: string; specialUse?: string }>, failAppend = false) {
  const calls: string[] = [];
  return {
    calls,
    list: async () => folders,
    mailboxCreate: async (p: string) => { calls.push(`create ${p}`); },
    append: async (p: string, _r: Buffer, f: string[]) => { calls.push(`append ${p} ${f.join(",")}`); if (failAppend) throw new Error("boom"); },
  };
}

test("saveToSent: missing folder is created, then appended with \\Seen", async () => {
  const c = fakeSentClient([{ path: "INBOX" }]);
  assert.equal(await saveToSent(c, { ...mb, folders: undefined }, Buffer.from("x")), "Gesendet");
  assert.deepEqual(c.calls, ["create Gesendet", "append Gesendet \\Seen"]);
});

test("saveToSent: existing \\Sent special-use folder used without create", async () => {
  const c = fakeSentClient([{ path: "INBOX" }, { path: "Sent Items", specialUse: "\\Sent" }]);
  assert.equal(await saveToSent(c, { ...mb, folders: undefined }, Buffer.from("x")), "Sent Items");
  assert.deepEqual(c.calls, ["append Sent Items \\Seen"]);
});

test("sendMail: append failure is ok with a warning", async () => {
  const r = await sendMail("site", { to: ["requester@example.org"], subject: "s", body: "b", inReplyTo: "a@x" },
    { mailbox: mb, identity: id, creds, isAccepted: () => true, findOriginal: async () => undefined, transmit: async () => {}, append: async () => { throw new Error("no folder"); } });
  assert.equal(r.ok, true);
  assert.match((r as { warning?: string }).warning ?? "", /no folder/);
});

// --- attachments -----------------------------------------------------------
function attFixture(): { dir: string; pdf: string } {
  const dir = mkdtempSync(join(tmpdir(), "mail-att-"));
  const pdf = join(dir, "Rechnung Ä vom 11.11.2026.pdf");
  writeFileSync(pdf, "%PDF-1.4 example");
  return { dir, pdf };
}

test("attachments: reach transmit and sent copy, together with the quote", async () => {
  const { pdf } = attFixture();
  const sent: BuiltMessage[] = [];
  let saved = "";
  const r = await sendMail("site", { to: ["requester@example.org"], subject: "Rechnung", body: "Anbei.", inReplyTo: "a@x", attachments: [pdf] },
    { mailbox: mb, identity: id, creds, isAccepted: () => true, findOriginal: async () => orig,
      transmit: async (_c, _m, m) => { sent.push(m); }, append: async (_c, _m, raw) => { saved = raw.toString("utf-8"); } });
  assert.equal(r.ok, true);
  assert.deepEqual(sent[0].attachments, [{ filename: "Rechnung Ä vom 11.11.2026.pdf", path: pdf }]);
  assert.match(saved, /multipart\/mixed/);
  assert.match(saved, /application\/pdf/);
  assert.match(saved, /filename\*=utf-8''|=\?UTF-8\?/i);
  assert.match(saved, /Anbei\./);
  assert.match(saved, /schrieb Example Requester/);
});

test("attachments: missing file or directory -> ok:false, nothing transmitted", async () => {
  const { dir } = attFixture();
  let touched = 0;
  const deps = { mailbox: mb, identity: id, creds, isAccepted: () => true, transmit: async () => { touched++; }, append: async () => { touched++; } };
  for (const p of [join(dir, "nope.pdf"), dir]) {
    const r = await sendMail("site", { to: ["requester@example.org"], subject: "x", body: "y", inReplyTo: "a@x", quote: false, attachments: [p] }, deps);
    assert.equal(r.ok, false);
  }
  assert.equal(touched, 0);
});

test("attachments: over the cap -> ok:false naming file and sizes, nothing transmitted", async () => {
  const { pdf } = attFixture();
  let touched = 0;
  const r = await sendMail("site", { to: ["requester@example.org"], subject: "x", body: "y", inReplyTo: "a@x", quote: false, attachments: [pdf] },
    { mailbox: mb, identity: id, creds, isAccepted: () => true, maxAttachmentBytes: 4, transmit: async () => { touched++; }, append: async () => { touched++; } });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /too large: .*Rechnung.*cap is/);
  assert.equal(touched, 0);
});
