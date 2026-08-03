# AIBroker

Claude Code is locked inside your terminal. You can only talk to it by typing. AIBroker breaks it out — send a WhatsApp voice note from the train, text from Telegram on your phone, or use the PAILot iOS app with full session management. Claude hears you, works on it, and replies in the same channel. Voice in, voice out.

Install AIBroker and your Claude Code sessions become reachable from anywhere. Ask Claude to check on your build while you're away from the desk. Send a screenshot request from WhatsApp. Switch between Claude sessions from your phone. It all routes through one daemon that owns the plumbing — TTS, transcription, image generation, screenshots, session management — so the adapters stay thin and the experience stays consistent.

---

## What You Can Do

### Talk to Claude from Your Phone

- **WhatsApp** — Send a text or voice note. Claude gets it, processes it, replies back. Voice in → voice out.
- **Telegram** — Same experience, different app. Text and voice both work.
- **PAILot** (iOS app) — Native companion app with session switching, voice messages, typing indicators, and message history.

### Delegate Work from Todoist

File a task in Todoist — from your phone, your watch, or the web — and the AI
session that owns that project picks it up, does the work, and answers in the
comments. Reply from the comments and it goes back to the same session.

No new app, no new habit: you delegate to it the way you delegate to a
colleague, and because the work happens on a task you can see what it is doing,
what it decided, and say no before anything happens.

[What it feels like](docs/task-manager-as-interface.md) · [Setup and security model](docs/todoist.md)

### Manage Sessions Remotely

- "Show me all sessions" — see every running Claude Code session
- "Switch to session 2" — route your messages to a different session
- "Start a new session for ~/projects/api" — launch a fresh Claude session from your phone
- "Screenshot" — capture what Claude is showing in iTerm right now
- "What's the status?" — see which sessions are busy, idle, or waiting

### Voice and Media

- **Voice notes** — Send a voice note from WhatsApp or Telegram. Whisper transcribes it, Claude processes it, Kokoro speaks the reply back as a voice note.
- **Image generation** — "Send me an image of a sunset over mountains" — Flux generates it, delivers it to your chat.
- **Screenshots** — Capture any iTerm session and receive the image on your phone.
- **Video analysis** — Send a video, Gemini analyzes it, Claude discusses the results.

### Slash Commands from Anywhere

Type these in any channel — WhatsApp, Telegram, PAILot, or terminal:

| Command | What it does |
|---------|-------------|
| `/s` | List all sessions |
| `/n ~/project` | Start a new visual session |
| `/ss` | Screenshot the active session |
| `/status` | Show all session statuses |
| `/image a cat in space` | Generate and deliver an image |
| `/e 3` | End session 3 |
| `/aibp` | AIBP protocol status — plugins, channels, commands |
| `/aibp plugins` | Detailed plugin list with capabilities |
| `/aibp commands` | All registered commands by owner |
| `/aibp help` | List all `/aibp` subcommands |

---

## Quick Start

Tell Claude Code:

> Clone https://github.com/mnott/AIBroker and set it up for me

Or manually:

### 1. Install

```bash
git clone https://github.com/mnott/AIBroker
cd AIBroker
npm install
npm run build
```

### 2. Configure the MCP server

Add to `~/.claude.json` under `mcpServers`:

```json
"aibroker": {
  "type": "stdio",
  "command": "node",
  "args": ["/path/to/AIBroker/dist/mcp/index.js"]
}
```

### 3. Start the daemon

```bash
aibroker start
```

The daemon runs as a macOS launchd service (`com.aibroker.daemon`). It owns the IPC socket at `/tmp/aibroker.sock` and the PAILot WebSocket gateway on port 8765.

### 4. Session backup across reboots (optional)

```bash
aibroker sessions install
```

Installs a LaunchAgent (`com.aibroker.sessions-snapshot`) that records your open Claude sessions (name + directory) every 5 minutes. Around a reboot:

```bash
aibroker sessions checkpoint   # before: tells each open session to persist its state
# reboot
aibroker sessions restore      # after: reopens every session in its own iTerm2 tab
```

`checkpoint` waits for each session to actually finish saving and prints a per-session result, so a session that never reacted is reported instead of silently skipped. Retry just those with `--only NAME`; raise `--timeout SECONDS` for slow ones.

`restore` relaunches a fresh named session per entry (which `go`s to pick up that project's saved state) — it does not rely on `claude --resume`.

The manifest (`~/.aibroker/session-restore.json`) is a **registry, not a mirror**: snapshots merge into it, so closing a session — or shutting everything down before a reboot — never removes anything. Entries leave only via `aibroker sessions forget NAME` or `aibroker sessions prune --older-than DAYS`, and every write keeps a `.bak`. See `aibroker sessions help` for the rest.

### 5. Dispatch work to a project's session

```bash
aibroker dispatch <project> --stdin --json [--no-spawn]
```

Resolves a project to its running Claude session and delivers a message, launching the session if none is running. One atomic call: a caller doing list → launch → send itself races, because a session can start or die between the check and the send.

The body comes in over **stdin** — task bodies are multi-line and carry quotes and backticks, which argv mangles. Messages arrive prefixed `[Task]`, meaning *act on it, do not reply* (unlike `[Session:NAME]`, there is no sender left to reply to).

Outcomes are results, not errors — all exit 0, so a batch keeps going:

| outcome | meaning |
|---|---|
| `delivered` | a live session accepted it |
| `spawned` | none was running; one was launched and accepted it |
| `unlaunchable` | no curated alias — run `pai project name <identifier> <shortname>` |
| `unreachable` | tab opened but the session never accepted input |
| `skipped` | no live session and `--no-spawn` was set |

Resolution uses the **curated** alias list only, never `pai project names --all`: the full set has no aliases and real ambiguity (several registry rows share a display name at different paths), so widening it dispatches work to the wrong directory silently. Bus participation is opt-in by design.

`spawned` means *confirmed submitted*, not *tab opened* — delivery is verified by watching the message leave the input box and land in the transcript, which works whether the session is idle or busy.

`--timeout SECONDS` is a **total budget for the whole dispatch**, not a per-stage cap: the readiness wait and the delivery share it, retries included. Callers that wrap this in their own kill timer should set it below theirs — then AIBroker always times out first and returns a reason, instead of being killed and surfacing as the caller's own timeout with the cause lost.

The logic lives in the daemon (`dispatch` IPC), so MCP, PAILot and adapters can route work without shelling out; the CLI is a thin, versioned wrapper for shell callers.

### 6. Ask a session whether it is still alive

```bash
aibroker ask <project> --stdin --timeout 60 --json
```

For callers with no session and no mailbox — a launchd poller checking whether the session it handed work to is still going. **Never spawns**: a probe that creates the thing it is probing turns a dead session into a fresh one and reports health.

| state | meaning |
|---|---|
| `replied` | it answered; `reply` holds its words |
| `busy` | mid-turn and still producing output. **Alive** — nothing was sent |
| `silent` | idle, took the question, never answered. Genuinely suspicious |
| `absent` | no live session for that project |

**`busy` is positive evidence of life and must not count toward a stuck threshold.** Claude Code queues typed input while mid-turn and only reads it when the turn ends, so a session busy doing exactly the work it was given cannot answer — and a short timeout would report it as silent. Since a scheduler probes precisely when a task has overrun, that false positive would fire constantly. Liveness is therefore decided *before* any question is sent, which also means a working session pays no token cost for being probed.

Every probe of an idle session does inject a message that stays in that session's context, so keep the text short and probe rarely.

### 7. File work from your phone or watch (optional)

```bash
tailscale funnel --bg --https=443 --set-path=/todoist http://127.0.0.1:8766/todoist
```

> **Port 443, and no port in the callback URL.** Todoist *silently* refuses any
> webhook URL carrying a port: the form accepts it, activation appears to do
> nothing, and the status stays *Not configured* forever with no error anywhere.
> `--https=8443` will look like it worked and never deliver a single event.

Add a task in Todoist and it reaches the session that owns it — no polling, because Todoist pushes. Set a **reminder** rather than a due date to schedule work: `reminder:fired` is a webhook event, a task merely becoming due is not.

This is an execution ingress, so it is narrow by construction: every request must carry a valid HMAC signature, only explicitly allowlisted projects can reach a session, and an empty allowlist accepts nothing rather than everything. Todoist's Inbox cannot be shared, which is what makes quick capture from a watch safe.

What it feels like to use: **[docs/task-manager-as-interface.md](docs/task-manager-as-interface.md)**.
Full setup, routing rules and the security model: **[docs/todoist.md](docs/todoist.md)**.

### 8. Audit what one session did to another

```bash
aibroker audit                       # recent cross-session activity
aibroker audit --session Youdrill    # everything touching one session
aibroker audit --trace <id>          # follow one causation chain
aibroker audit --bodies              # full message bodies
aibroker audit --json                # raw JSONL, for piping
```

Every daemon-mediated cross-session action — `send`, `dispatch`, `ask`, `launch`, and refusals — is appended to `~/.aibroker/audit.jsonl`, one JSON object per line, **before and independently of whatever the acting agent later reports**.

That distinction is the point. Sessions can now message each other, dispatch work, spawn new sessions and probe for liveness, and chains form that nobody designed: an observation in one project reaching a second session which relays it to a third. Without a record, the only account of any of it is each participant's own — a session that acts and does not mention it leaves no trace, and a session that ends takes its side of the story with it.

Bodies are stored in full, because a summary of a message is exactly the self-report this replaces. Refusals are stored too: "the hub declined to type this into a shell" is part of the history.

`--trace` walks a chain in both directions — what led to an event, and what it led to. Causation is inferred from the last message an actor received, which reconstructs `A→B→C` correctly in the ordinary case but is a heuristic, not proof: an agent may act for reasons of its own.

The format is deliberately plain JSONL: greppable with the tools already on the machine, appendable by any other tool that wants to contribute events, and a torn final line costs one record rather than the file. Set `AIBROKER_AUDIT_FILE` to relocate it.

### 9. Connect an adapter

```bash
# WhatsApp
npm install -g whazaa
whazaa watch

# Telegram
npm install -g telex
telex watch
```

Once connected, messages from your phone route to Claude and replies come back automatically.

---

## Architecture

```
  Your Phone                   AIBroker Daemon                   Claude Code
  ──────────                   ───────────────                   ──────────
  WhatsApp  ───► Whazaa  ──┐                                ┌──► Session 1 (iTerm)
  Telegram  ───► Telex   ──┤   Hub (IPC + AIBP routing)    ├──► Session 2 (iTerm)
  PAILot    ───► WS:8765 ──┤   TTS · STT · Screenshots     ├──► Session 3 (iTerm)
  Your App  ───► Adapter ──┘   Image Gen · Session Mgmt    └──► Headless (API)
```

**AIBroker is the runtime.** Adapters are thin transport plugins — they handle the network connection and nothing else. All intelligence lives in the hub: command parsing, message routing, media pipelines, session orchestration.

### AIBP Protocol

Internally, all messages flow through AIBP (AIBroker Protocol) — an IRC-inspired routing layer with explicit source/destination addressing, typed channels, and plugin registration.

```
Plugin A ──message──► #session:abc ──fan-out──► Plugin B, Plugin C, Plugin D
```

Every plugin declares its type and capabilities:

| Plugin Type | Examples | Capabilities |
|------------|----------|-------------|
| `transport` | Whazaa, Telex | TEXT, VOICE, IMAGE, FILE |
| `terminal` | iTerm2 | TEXT, COMMAND |
| `mobile` | PAILot | TEXT, VOICE, IMAGE, TYPING, STATUS |
| `mcp` | Claude Code sessions | TEXT, VOICE, IMAGE, COMMAND |
| `bridge` | Remote hubs | TEXT, VOICE, IMAGE, COMMAND, FILE |

Messages carry explicit `src` and `dst` addresses — no guessing which session should receive what. Cross-session messaging, mesh networking between machines, and channel fan-out all work through the same protocol.

### Inspecting the Protocol

Use `/aibp` from any channel (WhatsApp, Telegram, PAILot) or the `aibroker_aibp_status` MCP tool from Claude Code to see the live state of the routing infrastructure:

```
/aibp              → combined overview (sessions, plugins, channels, peers)
/aibp plugins      → registered plugins with type, status, capabilities
/aibp channels     → active channels with members and activity
/aibp commands     → all commands grouped by owning plugin
/aibp peers        → mesh network peers
```

`/status` and `/st` are shortcuts for `/aibp status`.

For the full protocol spec, see [docs/protocol.md](docs/protocol.md).

---

## MCP Tools

AIBroker exposes 42 MCP tools through a single unified server. Claude uses these automatically based on message routing rules — you don't need to call them manually.

### Message Routing

When a message arrives with a prefix, Claude knows where it came from and replies through the matching channel:

| Prefix | Source | Claude replies with |
|--------|--------|-------------------|
| `[Whazaa]` | WhatsApp text | `whatsapp_send` |
| `[Whazaa:voice]` | WhatsApp voice note | `whatsapp_tts` |
| `[Telex]` | Telegram text | `telegram_send` |
| `[Telex:voice]` | Telegram voice note | `telegram_tts` |
| `[PAILot]` | PAILot app text | `pailot_send` |
| `[PAILot:voice]` | PAILot app voice | `pailot_tts` |
| _(no prefix)_ | Terminal keyboard | Terminal only |

### Tool Categories

| Category | Tools | What they do |
|----------|-------|-------------|
| `whatsapp_*` | send, tts, contacts, chats, history, login, status | WhatsApp messaging and management |
| `telegram_*` | send, tts, contacts, chats, history, login, status | Telegram messaging and management |
| `pailot_*` | send, tts, receive | PAILot app communication |
| `aibroker_*` | status, sessions, switch, discover, speak, dictate, generate_image, ... | Hub-level operations |

For the complete reference, see [docs/mcp-tools.md](docs/mcp-tools.md).

---

## Bring Your Own Messenger

AIBroker adapters are standalone npm packages. A scaffold generator handles all the IPC wiring, MCP registration, and hub integration. You implement two things: how to connect and how to send.

```bash
aibroker create-adapter my-signal
cd my-signal
npm install
```

Full guide: [docs/adapters.md](docs/adapters.md)

---

## Media Pipelines

All media processing is centralized in the hub — adapters never touch TTS, transcription, or image generation directly.

| Pipeline | Technology | What happens |
|----------|-----------|-------------|
| **Text-to-Speech** | Kokoro (local) | Text → WAV → OGG Opus → delivered as voice note |
| **Speech-to-Text** | Whisper (local) | Voice note → transcription → delivered as text to Claude |
| **Image Generation** | Pluggable (see below) | Prompt → image → delivered to chat |
| **Image Analysis** | Claude Vision | Image → description → text response (no extra API cost on Max plan) |
| **Video Analysis** | Gemini 2.0 Flash | Video → analysis → text response (free tier: 15 RPM) |
| **Screenshots** | iTerm2 AppleScript | Capture terminal → PNG → delivered to chat |

### Image Generation — Works Out of the Box

Image generation uses [Pollinations.ai](https://pollinations.ai) by default — free, unlimited, no API key, no signup. Just ask Claude to generate an image and it works.

Want faster results? Upgrade to a paid provider by setting a single environment variable in `~/.aibroker/env`:

| Provider | Setup | Speed | Cost |
|----------|-------|-------|------|
| **Pollinations** _(default)_ | Nothing — works immediately | ~20s | Free |
| **Replicate** | `REPLICATE_API_TOKEN=r8_...` | 2-4s | ~$0.003/image |
| **Cloudflare Workers AI** | `CLOUDFLARE_AI_TOKEN=...` + `CLOUDFLARE_ACCOUNT_ID=...` | 3-5s | Free (~100/day) |
| **Hugging Face** | `HF_API_TOKEN=hf_...` | 5-15s | Free (rate-limited) |

AIBroker auto-detects which token is set and uses that provider. No config file needed.

**Pin a specific provider** with `~/.aibroker/image-gen.json`:

```json
{
  "provider": "replicate"
}
```

**Bring your own provider** — point to any Node.js module that implements the `ImageProvider` interface:

```json
{
  "provider": "custom",
  "modulePath": "/path/to/my-provider.js",
  "options": { "apiKey": "...", "endpoint": "https://my-api.com" }
}
```

Your module exports one function:

```typescript
import type { ImageProvider, ImageProviderConfig } from "aibroker";

export function createProvider(config: ImageProviderConfig): ImageProvider {
  return {
    name: "my-provider",
    async generate(opts) {
      const res = await fetch(config.options.endpoint, { /* ... */ });
      return {
        images: [Buffer.from(await res.arrayBuffer())],
        model: "my-model",
        durationMs: 0,
      };
    },
  };
}
```

All built-in providers use FLUX.1 Schnell by default. Override with `"model": "your-model-id"` in the config.

### Iterative Refinement

Image generation is conversational. Generate an image, then refine it with follow-up messages:

```
You:    "Send me an image of a fish sitting on a chair"
Claude: [image]
You:    "Put a tie on it"
Claude: [refined image — fish on chair, now wearing a tie]
You:    "Make it watercolor style"
Claude: [refined image — watercolor fish with tie on chair]
```

AIBroker detects refinement intent from modification verbs ("put", "add", "make"), image references ("it", "the image"), style keywords ("watercolor", "cartoon"), and prepositional modifiers ("with a hat", "without the chair"). Messages that don't reference the image pass through to Claude normally — no manual "stop" needed.

Image context is scoped per source, recipient, and session, so multiple users or devices never interfere. Context expires after 30 minutes of inactivity. Say "new image" or "start over" to reset explicitly.

---

## PAILot Companion App

PAILot is a native iOS app that connects to AIBroker over WebSocket. It provides:

- **Session management** — switch between Claude sessions, start new ones, end old ones
- **Voice messages** — record and send, receive voice replies with chain playback
- **Typing indicators** — see when Claude is processing
- **Message history** — persistent chat with text and voice
- **Offline queuing** — messages buffer on the server when you're disconnected, drain on reconnect
- **Session isolation** — the gateway tracks which session each client is viewing and only delivers matching messages, preventing cross-session content bleed

PAILot connects to `ws://your-mac:8765`. See [docs/pailot.md](docs/pailot.md).

---

## Mesh Networking

Two AIBroker instances on different machines can exchange messages through AIBP bridge plugins. A message from PAILot on Machine A can reach a Claude session on Machine B:

```
Machine A                          Machine B
─────────                          ─────────
PAILot ──► Hub A ──bridge──► Hub B ──► Claude Session
```

Addressing is explicit: `hub:machine-b/session:abc` routes through the bridge to the remote hub. See [docs/mesh.md](docs/mesh.md).

---

## Documentation

| Document | What it covers |
|----------|---------------|
| [architecture.md](docs/architecture.md) | System design, component interactions, data flow |
| [protocol.md](docs/protocol.md) | AIBP protocol specification |
| [plugins.md](docs/plugins.md) | Plugin types, registration, capabilities |
| [routing.md](docs/routing.md) | Message routing logic and channel system |
| [sessions.md](docs/sessions.md) | Session management and lifecycle |
| [commands.md](docs/commands.md) | Slash command reference |
| [mcp-tools.md](docs/mcp-tools.md) | All 42 MCP tools with parameters |
| [adapters.md](docs/adapters.md) | Adapter development guide |
| [pailot.md](docs/pailot.md) | PAILot iOS app integration |
| [task-manager-as-interface.md](docs/task-manager-as-interface.md) | Todoist as the front door to AI: what it feels like, what it will not do |
| [todoist.md](docs/todoist.md) | Todoist inbound channel: webhook setup, routing, security model, the comment mirror |
| [channels.md](docs/channels.md) | The model every inbound path shares — read first for anything inbound |
| [inbound.md](docs/inbound.md) | Generic `POST /hook/<route>` endpoint |
| [outbound.md](docs/outbound.md) | Acting in external systems through a platform's own actions |
| [mailbox.md](docs/mailbox.md) | Durable per-session queue and confirmed delivery |
| [audit.md](docs/audit.md) | What is recorded, and how to read it |
| [mesh.md](docs/mesh.md) | Multi-machine mesh networking |
| [ipc.md](docs/ipc.md) | IPC protocol and message format |
| [tts-stt.md](docs/tts-stt.md) | Voice pipeline details |
| [use-cases.md](docs/use-cases.md) | End-to-end message flow diagrams |
| [protocol-landscape.md](docs/protocol-landscape.md) | How AIBP relates to A2A, MCP, and other standards |
| [configuration.md](docs/configuration.md) | Configuration reference |
| [development.md](docs/development.md) | Development setup and testing |

---

## Hard Rule

AIBroker never imports `@whiskeysockets/baileys`, `telegram`/`gramjs`, `better-sqlite3`, `qrcode`, or any transport-specific SDK. Platform-specific dependencies belong in the adapter packages.

---

## Companion Projects

| Package | What it does | Repo |
|---------|-------------|------|
| **[PAI](https://github.com/mnott/PAI)** | Knowledge OS — persistent memory, session continuity, semantic search for Claude Code | [github.com/mnott/PAI](https://github.com/mnott/PAI) |
| **[Whazaa](https://github.com/mnott/Whazaa)** | WhatsApp adapter — voice notes, media, contact management | [github.com/mnott/Whazaa](https://github.com/mnott/Whazaa) |
| **[Telex](https://github.com/mnott/Telex)** | Telegram adapter — text and voice messaging | [github.com/mnott/Telex](https://github.com/mnott/Telex) |
| **[Coogle](https://github.com/mnott/Coogle)** | Google Workspace MCP — Gmail, Calendar, Drive multiplexing | [github.com/mnott/Coogle](https://github.com/mnott/Coogle) |
| **[DEVONthink MCP](https://github.com/mnott/devonthink-mcp)** | DEVONthink integration — document search and archival | [github.com/mnott/devonthink-mcp](https://github.com/mnott/devonthink-mcp) |

---

## License

MIT — Matthias Nott
