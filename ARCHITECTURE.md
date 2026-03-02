# AIBroker Architecture

## What This Is

AIBroker is a platform-agnostic message broker that sits between **user-facing channels** and **AI backends**. It routes messages, manages sessions, and provides shared infrastructure so that each channel and backend only implements a thin adapter.

```
User Channels                                AI Backends

  WhatsApp (Whazaa)  ───┐                ┌───  Claude Code (CLI)
  Telegram (Telex)   ───┤                ├───  ChatGPT (CLI)
  Claudaemon (Web)   ───┤                ├───  ollama (local)
  Terminal (direct)  ───┼── AIBroker ────┼───  Anthropic API
  Voice (local mic)  ───┤   (routes)     ├───  OpenAI API
  Future channels    ───┘                └───  Future backends
```

## Hard Rule

AIBroker may **NEVER** import `@whiskeysockets/baileys`, `telegram`/`gramjs`, `better-sqlite3`, `qrcode`, or any transport/platform SDK. If a module needs one of these, it belongs in the per-project package (Whazaa, Telex, etc.), not here.

## Two Pluggable Dimensions

### Channel (user-facing)

A Channel is how the user sends and receives messages. Each channel implements the `Transport` interface:

| Channel | Package | Transport SDK |
|---------|---------|---------------|
| WhatsApp | Whazaa | Baileys |
| Telegram | Telex | GramJS |
| Claudaemon | claudaemon | WebSocket |
| Terminal | (built-in) | stdin/stdout |
| Voice | (adapter) | local mic + TTS |

### Backend (AI-facing)

A Backend is how AIBroker delivers messages to an AI model and gets responses.

**SessionBackend** — Runs a CLI process in a terminal session. Types the message into the session, the AI responds asynchronously, and the watcher picks up the response.

| CLI | Command | Notes |
|-----|---------|-------|
| Claude Code | `claude` | Current default |
| ChatGPT CLI | `chatgpt` | Future |
| ollama | `ollama run llama3` | Local models |

**APIBackend** — Calls an AI provider's HTTP API directly. Response comes back synchronously and is sent via the channel. No terminal involved.

| Provider | API | Notes |
|----------|-----|-------|
| Anthropic | Messages API | Claude models |
| OpenAI | Chat Completions | GPT models |
| ollama | localhost:11434 | Local models |

**Claudaemon** — A special case. It's both a channel (web UI for the user) AND potentially a backend (if it manages its own AI conversations). The architecture supports this — it just implements both interfaces.

## Message Flow

```
1. User sends message via Channel (e.g., WhatsApp)
2. Channel calls Transport.onMessage(text, metadata)
3. AIBroker's MessageRouter determines which Backend handles this session
4. Backend.deliver(message, sessionId) sends to the AI
   - SessionBackend: types into terminal session, response comes async
   - APIBackend: HTTP call, response returned directly
5. Response sent back via the originating Channel
```

## Directory Layout

```
src/
├── types/              Platform-independent type definitions
│   ├── transport.ts      Transport interface (what channels implement)
│   ├── backend.ts        Backend interface (what AI connectors implement)
│   ├── ipc.ts            IPC request/response protocol
│   ├── session.ts        Session registry, queued messages
│   ├── voice.ts          Voice config, personas
│   └── index.ts          Barrel re-export
│
├── core/               Platform-independent core logic
│   ├── router.ts         MessageRouter — routes sessions to backends
│   ├── state.ts          Session registry, message queues, dispatch
│   ├── persistence.ts    Disk I/O (parameterized via setAppDir)
│   ├── log.ts            Timestamped logger (configurable prefix)
│   ├── markdown.ts       Shared markdown transforms
│   └── mime.ts           MIME type lookup
│
├── ipc/                Inter-process communication
│   ├── server.ts         IPC server (Unix socket, handler registry)
│   └── client.ts         WatcherClient (injectable socket path)
│
├── adapters/           Optional, platform-specific adapters
│   ├── iterm/            macOS iTerm2 — AppleScript session management
│   │   ├── core.ts         runAppleScript, typeIntoSession, etc.
│   │   ├── sessions.ts     Session lifecycle, tab management
│   │   └── dictation.ts    Mic recording + Whisper transcription
│   │
│   ├── kokoro/           Kokoro TTS engine + Whisper STT
│   │   ├── tts.ts          textToVoiceNote, speakLocally, listVoices
│   │   └── media.ts        transcribeAudio, splitIntoChunks
│   │
│   └── session/          SessionBackend — deliver via terminal
│       └── backend.ts      Wraps typeIntoSession for message delivery
│
├── backend/            Backend implementations
│   └── api.ts            APIBackend — direct HTTP to AI providers (stub)
│
└── index.ts            Barrel export (all public symbols)
```

## What's Core vs What's an Adapter

**Core** (works everywhere, no OS dependencies):
- Types and interfaces
- Message routing and session state
- Persistence (file-based, parameterized paths)
- IPC protocol (Unix sockets)
- Logging, markdown transforms, MIME lookup

**Adapters** (optional, platform-specific):
- `adapters/iterm/` — macOS only. Uses AppleScript. On Linux, a different terminal adapter would be needed.
- `adapters/kokoro/` — Kokoro TTS. Could be swapped for browser-based TTS, system TTS, or Claudaemon's own speech.
- `adapters/session/` — SessionBackend. Depends on a terminal adapter (currently iTerm2). On Linux, would use a generic terminal adapter instead.

## Future Adapters (not yet built)

| Adapter | Purpose | When |
|---------|---------|------|
| `adapters/terminal/` | Generic CLI adapter for Linux (no AppleScript) | When Linux support is needed |
| `adapters/claudaemon/` | WebSocket bridge to Claudaemon web UI | When Claudaemon integration starts |
| `adapters/browser-tts/` | Browser-based speech synthesis/recognition | When Claudaemon handles voice |

## Consumers

Each messaging project is a thin wrapper:

**Whazaa** (WhatsApp MCP server):
- Implements `WhatsAppTransport` using Baileys
- Registers WhatsApp-specific IPC handlers
- Defines `whatsapp_*` MCP tools
- Imports everything else from AIBroker

**Telex** (Telegram MCP server):
- Implements `TelegramTransport` using GramJS
- Registers Telegram-specific IPC handlers
- Defines `telegram_*` MCP tools
- Imports everything else from AIBroker

**Claudaemon** (future):
- Implements both a Channel (web UI) and potentially a Backend
- Could route messages through AIBroker or manage AI conversations directly

## Key Interfaces

### Transport (channels implement this)

```typescript
interface Transport {
  readonly name: string;              // "WhatsApp", "Telegram", "Claudaemon"
  readonly messagePrefix: string;     // "[Whazaa]", "[Telex]"
  readonly voicePrefix: string;       // "[Whazaa:voice]", "[Telex:voice]"

  connect(onMessage: MessageHandler): Promise<void>;
  disconnect(): Promise<void>;
  getStatus(): ConnectionStatus;
  sendMessage(text: string, recipient?: string): Promise<string>;
  sendFile(path: string, recipient?: string, caption?: string): Promise<void>;
  sendVoiceNote(buffer: Buffer, recipient?: string): Promise<void>;
  startTyping(recipient?: string): void;
  stopTyping(): void;
  formatMarkdown(text: string): string;
  resolveRecipient(query: string): Promise<string | null>;
}
```

### Backend (AI connectors implement this)

```typescript
interface Backend {
  readonly name: string;        // "claude", "chatgpt", "ollama-llama3"
  readonly type: "session" | "api";
  deliver(message: string, sessionId?: string): Promise<string | undefined>;
  // undefined = async (session-based, response comes via watcher)
  // string = sync (API-based, caller sends via transport)
}
```

### MessageRouter

```typescript
class MessageRouter {
  setDefaultBackend(backend: Backend): void;
  route(sessionId: string): Backend;
  setBackend(sessionId: string, backend: Backend): void;
  removeBackend(sessionId: string): void;
  listBackends(): { sessionId: string; backend: string }[];
}
```

## Current Status

| Component | Status |
|-----------|--------|
| Types + interfaces | Done |
| Core (state, persistence, router, log, markdown, mime) | Done |
| IPC (client, server) | Done |
| iTerm2 adapter | Done (macOS only) |
| Kokoro TTS adapter | Done |
| SessionBackend | Done (wraps iTerm2) |
| APIBackend | Stub only |
| Terminal adapter (Linux) | Not started |
| Claudaemon adapter | Not started |
| Whazaa integration (import from AIBroker) | Not started |
| Telex integration (import from AIBroker) | Done — log, state, persistence, iterm, tts re-exported from AIBroker |

## Next Steps

1. **Wire up Whazaa** — Same migration pattern as Telex
2. **Implement APIBackend** — Direct HTTP calls to Anthropic/OpenAI/ollama
3. **Generic terminal adapter** — For Linux (no AppleScript dependency)
4. **Claudaemon integration** — WebSocket channel + potential backend
