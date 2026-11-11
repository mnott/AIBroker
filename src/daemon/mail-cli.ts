/**
 * daemon/mail-cli.ts — `aibroker mail send --mailbox <name> --to a[,b] [--cc ..]
 * --subject <s> --body-file <path> [--in-reply-to <msgid>] [--attach <path>]...`.
 * All rules live in mail-send.sendMail; this only parses arguments.
 */
import { readFileSync } from "node:fs";

const USAGE = "Usage: aibroker mail send --mailbox <name> --to <addr[,addr]> [--cc <addr[,addr]>] --subject <text> --body-file <path> [--in-reply-to <message-id>] [--no-quote] [--attach <path>]...";

export async function runMail(args: string[]): Promise<void> {
  const [verb, ...rest] = args;
  if (verb !== "send") { console.error(USAGE); process.exit(1); }
  const o: Record<string, string> = {};
  const attach: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i];
    if (k === "--no-quote") { o["no-quote"] = "1"; continue; }
    if (!k.startsWith("--") || rest[i + 1] === undefined) { console.error(USAGE); process.exit(1); }
    if (k === "--attach") { attach.push(rest[++i]); continue; }
    o[k.slice(2)] = rest[++i];
  }
  if (!o.mailbox || !o.to || !o.subject || !o["body-file"]) { console.error(USAGE); process.exit(1); }
  const list = (v?: string) => (v ? v.split(/[,;]/).map((x) => x.trim()).filter(Boolean) : []);
  const { sendMail } = await import("./mail-send.js");
  const r = await sendMail(o.mailbox, {
    to: list(o.to), cc: list(o.cc), subject: o.subject,
    body: readFileSync(o["body-file"], "utf-8"), inReplyTo: o["in-reply-to"], quote: o["no-quote"] ? false : undefined,
    attachments: attach.length ? attach : undefined,
  });
  if (!r.ok) { console.error(r.error); process.exit(1); }
  if (r.warning) console.error(`warning: ${r.warning}`);
  console.log(`sent ${r.messageId} to=${r.to.join(",")} cc=${r.cc.join(",")}`);
  process.exit(0);
}
