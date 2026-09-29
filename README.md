# AIBroker

Claude Code is locked inside your terminal. You can only talk to it by typing. AIBroker breaks it out — send a WhatsApp voice note from the train, text from Telegram on your phone, or use the PAILot iOS app with full session management. Claude hears you, works on it, and replies in the same channel. Voice in, voice out.

Install AIBroker and your Claude Code sessions become reachable from anywhere. Ask Claude to check on your build while you're away from the desk. Send a screenshot request from WhatsApp. Switch between Claude sessions from your phone. It all routes through one daemon that owns the plumbing — TTS, transcription, image generation, screenshots, session management — so the adapters stay thin and the experience stays consistent.

- Talk to Claude from WhatsApp, Telegram or the PAILot app, by text or voice
- Delegate work from Todoist and manage sessions remotely
- Generate images, transcribe voice notes, screenshot a session

---

## Install

```bash
npm install -g aibroker
aibroker setup      # service + MCP registration + Claude Code hooks + ~/.aibroker/env
aibroker doctor     # every check green, or it says exactly what to fix
```

Then connect an adapter: `npm install -g whazaa && whazaa setup` (WhatsApp) or `npm install -g @tekmidian/telex && telex setup` (Telegram). Platform guides: [macOS](docs/macos.md), [Linux](docs/linux.md). Flags, source checkout and the adapter service commands: [docs/install.md](docs/install.md).

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

One unified MCP server exposes 42 tools (`whatsapp_*`, `telegram_*`, `pailot_*`, `aibroker_*`). Message prefixes such as `[Whazaa:voice]` tell Claude which channel to reply through.

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
