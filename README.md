# AIBroker

Claude Code is locked inside your terminal. You can only talk to it by typing. AIBroker breaks it out — send a WhatsApp voice note from the train, text from Telegram on your phone, or use the PAILot iOS app with full session management. Claude hears you, works on it, and replies in the same channel. Voice in, voice out.

Install AIBroker and your Claude Code sessions become reachable from anywhere. Ask Claude to check on your build while you're away from the desk. Send a screenshot request from WhatsApp. Switch between Claude sessions from your phone. It all routes through one daemon that owns the plumbing — TTS, transcription, image generation, screenshots, session management — so the adapters stay thin and the experience stays consistent.

- Talk to Claude from WhatsApp, Telegram or the PAILot app, by text or voice
- Delegate work from Todoist and manage sessions remotely
- Generate images, transcribe voice notes, screenshot a session

---

## Install

```bash
npm i -g https://github.com/mnott/AIBroker/releases/latest/download/aibroker.tgz
aibroker setup      # service + MCP registration + Claude Code hooks + ~/.aibroker/env
aibroker doctor     # every check green, or it says exactly what to fix
```

Then connect an adapter: `npm i -g https://github.com/mnott/Whazaa/releases/latest/download/whazaa.tgz && whazaa setup` (WhatsApp) or `npm i -g https://github.com/mnott/Telex/releases/latest/download/telex.tgz && telex setup` (Telegram). Update: `pai update --package aibroker`. The npm registry is no longer updated; releases come from GitHub. Platform guides: [macOS](docs/macos.md), [Linux](docs/linux.md). Flags, source checkout and the adapter service commands: [docs/install.md](docs/install.md).

---

## What You Can Do

Text and voice from WhatsApp, Telegram and PAILot; delegating from Todoist; listing, switching, launching and screenshotting sessions; voice notes, image generation, video analysis; slash commands such as `/s`, `/n`, `/ss`, `/status`, `/image` from any channel.

→ [docs/what-you-can-do.md](docs/what-you-can-do.md)

## Session Backup and Dispatch

`aibroker sessions` records your open sessions and restores them after a reboot. `aibroker dispatch` delivers a message to a project's session, launching it if needed; `aibroker ask` probes whether a session is still alive without ever spawning one.

→ [docs/session-backup.md](docs/session-backup.md) · [docs/dispatch.md](docs/dispatch.md)

## Todoist

File a task from your phone or watch and the session that owns that project picks it up. Todoist pushes, so there is no polling; the ingress is narrow by construction (HMAC, allowlisted projects).

→ [docs/todoist.md](docs/todoist.md) · [docs/task-manager-as-interface.md](docs/task-manager-as-interface.md)

## Audit

Every daemon-mediated cross-session action, refusals included, is appended to `~/.aibroker/audit.jsonl` before and independently of what the acting agent reports. `aibroker audit` reads it.

→ [docs/audit.md](docs/audit.md)

## Architecture and AIBP Protocol

The hub is the runtime; adapters are thin transport plugins. Internally every message flows through AIBP, an IRC-inspired routing layer with explicit source and destination addresses, typed channels and plugin registration. `/aibp` inspects the live state.

→ [docs/architecture.md](docs/architecture.md) · [docs/protocol.md](docs/protocol.md)

## MCP Tools

One unified MCP server exposes 43 tools (`whatsapp_*`, `telegram_*`, `pailot_*`, `aibroker_*`). Message prefixes such as `[Whazaa:voice]` tell Claude which channel to reply through.

→ [docs/mcp-tools.md](docs/mcp-tools.md)

## Bring Your Own Messenger

Adapters are standalone npm packages. `aibroker create-adapter my-signal` scaffolds the IPC wiring, MCP registration and hub integration; you implement how to connect and how to send.

→ [docs/adapters.md](docs/adapters.md)

## Media Pipelines

TTS (Kokoro), STT (Whisper), image generation (Pollinations by default, Replicate, Cloudflare, Hugging Face or your own provider), image and video analysis, screenshots. Image generation is conversational and refines on follow-ups.

→ [docs/media.md](docs/media.md)

## PAILot Companion App

A native iOS app that connects to AIBroker over WebSocket: session management, voice messages, typing indicators, message history, offline queuing and session isolation.

→ [docs/pailot.md](docs/pailot.md)

## Pair Programming, for Agents

Two Claude sessions work the same repository overnight while a manager session keeps both pointed at the work: it holds the objective, refuses to let a session stand down, watches the context wall and arbitrates the split.

→ [docs/pair-programming.md](docs/pair-programming.md) · [docs/managed-sessions.md](docs/managed-sessions.md) · [docs/session-watchdog.md](docs/session-watchdog.md)

## Mesh Networking

Two AIBroker instances on different machines exchange messages through AIBP bridge plugins; `hub:machine-b/session:abc` routes through the bridge to the remote hub.

→ [docs/mesh.md](docs/mesh.md)

## Documentation

The full page index, including configuration, IPC, voice pipeline, use cases and development.

→ [docs/README.md](docs/README.md)

---

## Credits

AIBroker never imports `@whiskeysockets/baileys`, `telegram`/`gramjs`, `better-sqlite3`, `qrcode`, or any transport-specific SDK. Platform-specific dependencies belong in the adapter packages ([docs/development.md](docs/development.md)).

Companion projects:

| Package | What it does | Repo |
|---------|-------------|------|
| **[PAI](https://github.com/mnott/PAI)** | Knowledge OS — persistent memory, session continuity, semantic search for Claude Code | [github.com/mnott/PAI](https://github.com/mnott/PAI) |
| **[Whazaa](https://github.com/mnott/Whazaa)** | WhatsApp adapter — voice notes, media, contact management | [github.com/mnott/Whazaa](https://github.com/mnott/Whazaa) |
| **[Telex](https://github.com/mnott/Telex)** | Telegram adapter — text and voice messaging | [github.com/mnott/Telex](https://github.com/mnott/Telex) |
| **[Coogle](https://github.com/mnott/Coogle)** | Google Workspace MCP — Gmail, Calendar, Drive multiplexing | [github.com/mnott/Coogle](https://github.com/mnott/Coogle) |
| **[DEVONthink MCP](https://github.com/mnott/devonthink-mcp)** | DEVONthink integration — document search and archival | [github.com/mnott/devonthink-mcp](https://github.com/mnott/devonthink-mcp) |

## License

MIT — Matthias Nott

## Publishing to the OTA hub

`aibroker ota publish --slug myapp --name "My App" --bundle com.example.app --version 1.0.0 --platform ios build/app.ipa` uploads an IPA or APK to the OTA install hub and prints the install URL (only that, on stdout). Any failure exits non-zero with a one-line reason on stderr. It is the CLI twin of the MCP tool `ota_publish`.

## Mail ingress

A dedicated mailbox can feed change requests to a session. Config: `~/.aibroker/mail-ingress.json` (read on every reconnect; `aibroker owner rename` also rewrites `owner` here). The daemon holds one IMAPS (993) connection per mailbox, fetches all UNSEEN mail on every (re)connect and then uses IMAP IDLE; reconnects back off exponentially (5 s to 5 min).

```json
{
  "mailboxes": [
    {
      "name": "site",
      "credentialsFile": "~/.aibroker/mail-site.credentials",
      "owner": "Example Project",
      "autoLaunch": true,
      "project": "example-project",
      "allowlist": ["requester@example.org"],
      "includeSelfEmails": false,
      "operatorCc": "operator@example.org",
      "displayName": "Example Site",
      "folders": { "accepted": "Eingegangen", "rejected": "Abgelehnt", "sent": "Gesendet" }
    }
  ]
}
```

The credentials file is `key=value` lines (`user`, `pass`, `imap`, `smtp`; `imap`/`smtp` as `host` or `host:port`, defaults 993 and 587, port 465 means implicit TLS) and must be mode 600 or it is refused. The password is never logged.

Adding a mailbox: append one entry to `mailboxes` (own `name`, credentials file, `owner` session, `allowlist`, `operatorCc`) and create its credentials file with mode 600; it is picked up at the next reconnect or `aibroker restart`. Each mailbox has its own connection, allowlist, target session and Cc.

Gate (per message), all of:

1. Exactly one From address, on the mailbox's effective allowlist (`allowlist` + `operatorCc`, plus `identity.selfEmails` from `~/.pai/config.yaml` when `includeSelfEmails` is true).
2. The mailbox's own address is in To or Cc.
3. AIBroker verifies the DKIM signatures itself (`mailauth`, live DNS): at least one must pass (header and body hash), with `d=` aligned to the From domain, and its signed headers must cover `From` and the To/Cc header naming the mailbox (anti-replay).

`Authentication-Results` and `Received` headers are not trusted. A DNS temperror leaves the message UNSEEN for the next cycle instead of rejecting it. A failed message is moved to the rejected folder with one log line (from, message-id, reason) and nothing else: no bounce, auto-reply or read receipt, so the mailbox never reveals that it is read.

Accepted mail is deposited in the owner session's mailbox (text starts with `[Mail:<name>]`, attachments saved under `~/.aibroker/mail-attachments/<message-id>/`), then flagged `\Seen` and moved to the accepted folder. If the owner session is not running, AIBroker starts it (per mailbox `autoLaunch`, default `true`): the mail becomes the work order of a new session launched through the normal dispatch path (prefix `[Mail:<name>]`), the session is named exactly `owner`, and PAILot gets one line (`Started <owner> for mail <subject>`; no body, no addresses). `project` (optional, PAI project slug or folder path) selects what to launch; without it the project is resolved from the `owner` name like any dispatch target. One launch runs per owner at a time; further mail waits and is delivered to the running session. A failed launch leaves the mail UNSEEN and is not retried sooner than 10 minutes. With `autoLaunch: false` (or when the launch failed) the message stays UNSEEN and is retried every 5 minutes and at the next reconnect. Accepted message-ids are persisted (`mail-accepted.json`) for dedupe and for the send rules.

### Sending: `aibroker mail send` / MCP `aibroker_mail_send`

```
aibroker mail send --mailbox webseite --to requester@example.org [--cc ...] \
  --subject "Re: ..." --body-file reply.txt --in-reply-to '<message-id>' [--no-quote]
```

One function (`sendMail`) serves both, with unconditional rules (no override flag, no Bcc):

1. Every To/Cc must be on the mailbox allowlist, in `identity.selfEmails`, or be `operatorCc`; otherwise nothing is sent or saved.
2. A recipient that is not self/operator requires `--in-reply-to` naming a message-id this mailbox accepted via ingress.
3. `operatorCc` is always added as Cc; sending is refused if it is unset.
4. SMTP submission on 587 with STARTTLS, then the copy is saved to the sent folder via IMAP APPEND (the sent folder is created if missing; a failed save is reported as a warning). One log line per send (mailbox, recipients, ids); never body or password.
5. Quoting: with `--in-reply-to`, the original (looked up by Message-ID in the accepted folder, then INBOX) is quoted below the body like a normal reply: `Am dd.mm.yyyy um HH:MM schrieb Name <addr>:` (local time) followed by the original plain text with every line prefixed `> ` (already quoted lines become `>>`). `References` is the original's References plus its Message-ID, and the subject gets exactly one `Re:`. If the original cannot be found the mail is sent without quote and one warning line is logged. `--no-quote` (MCP: `quote: false`) skips the lookup.
