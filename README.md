# AIBroker

Claude Code is locked inside your terminal. You can only talk to it by typing. AIBroker breaks it out — send a WhatsApp voice note from the train, text from Telegram on your phone, or use the PAILot iOS app with full session management. Claude hears you, works on it, and replies in the same channel. Voice in, voice out.

Install AIBroker and your Claude Code sessions become reachable from anywhere. Ask Claude to check on your build while you're away from the desk. Send a screenshot request from WhatsApp. Switch between Claude sessions from your phone. It all routes through one daemon that owns the plumbing — TTS, transcription, image generation, screenshots, session management — so the adapters stay thin and the experience stays consistent.

---

## What You Can Do

### Talk to Claude from Your Phone

- **WhatsApp** — Send a text or voice note. Claude gets it, processes it, replies back. Voice in → voice out.
- **Telegram** — Same experience, different app. Text and voice both work.
- **PAILot** (iOS app) — Native companion app with session switching, voice messages, typing indicators, and message history.

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

### 4. Connect an adapter

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

---

## PAILot Companion App

PAILot is a native iOS app that connects to AIBroker over WebSocket. It provides:

- **Session management** — switch between Claude sessions, start new ones, end old ones
- **Voice messages** — record and send, receive voice replies with chain playback
- **Typing indicators** — see when Claude is processing
- **Message history** — persistent chat with text and voice
- **Offline queuing** — messages buffer on the server when you're disconnected, drain on reconnect

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
