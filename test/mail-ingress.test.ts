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
import { sendMail } from "../src/daemon/mail-send.js";
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
    { mailbox: mb, identity: id, creds, isAccepted: () => true,
      transmit: async (_c, _m, msg) => { calls.push(`tx cc=${msg.cc.join(",")} irt=${msg.inReplyTo}`); },
      append: async () => { calls.push("append"); } });
  assert.equal(r.ok, true);
  assert.deepEqual(calls, ["tx cc=operator@example.org irt=<a@x>", "append"]);
  assert.equal(decideSend({ ...mb, operatorCc: undefined }, id, { to: ["me@example.org"], subject: "s", body: "b" }).ok, false);
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
