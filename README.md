# aibroker

Platform-agnostic AI message broker — shared infrastructure for messaging
bridges that connect WhatsApp, Telegram, and other channels to Claude Code.

---

## Architecture

```
  Messaging Services           AIBroker Hub             AI Backends
  ─────────────────           ────────────             ───────────
  WhatsApp (Whazaa)  ──────>                ──────>  Anthropic Claude
  Telegram (Telex)   ──────>   Hub Daemon   ──────>  OpenAI
  iOS App (PAILot)   ──────>                ──────>  Ollama (local)
  Your Adapter       ──────>                ──────>  Custom Backend
```

Each adapter is a standalone npm package. The hub daemon routes messages between adapters and AI backends. Everything communicates over Unix Domain Sockets.

---

## Supported Adapters

| Package | Channel | Repo |
|---------|---------|------|
| **whazaa** | WhatsApp | [github.com/mnott/Whazaa](https://github.com/mnott/Whazaa) |
| **telex** | Telegram | [github.com/mnott/Telex](https://github.com/mnott/Telex) |
| **pailot** | iOS companion app | Built into aibroker (`adapters/pailot/`) |

Want to connect a different service? See [docs/CREATE_ADAPTER.md](docs/CREATE_ADAPTER.md).

---

## Supported AI Backends

| Provider | Model Access | Tool Use | Conversation History |
|----------|-------------|----------|---------------------|
| **Anthropic Claude** | Claude Agent SDK subprocess | Yes (full tool access) | Yes (session resume) |
| **OpenAI** | Chat Completions API | No | No (stateless) |
| **Ollama** | Local Ollama HTTP API | No | No (stateless) |
| **Custom** | Your implementation | Optional | Optional |

Want to connect a different AI provider? See [docs/BACKEND_GUIDE.md](docs/BACKEND_GUIDE.md).

---

## Quick Start

### 1. Install

```bash
npm install -g aibroker
```

### 2. Configure

Create `~/.aibroker/config.json`:

```json
{
  "adapters": [
    {
      "name": "whazaa",
      "socketPath": "/tmp/whazaa-watcher.sock"
    }
  ],
  "backend": {
    "type": "api",
    "provider": "anthropic",
    "model": "claude-opus-4-5"
  }
}
```

### 3. Start the daemon

```bash
aibroker start
```

Check status:

```bash
aibroker status
```

### 4. Install and start an adapter

```bash
npm install -g whazaa
whazaa watch
```

Once the adapter watcher is running, messages from your messaging service are routed to the configured AI backend and replies are sent back automatically.

---

## Bring Your Own Messenger

AIBroker adapters are standalone npm packages. The scaffold takes care of all IPC wiring, MCP tool registration, and hub integration. You only implement two functions: `connectWatcher()` (connect to the service) and `sendText()` / `sendVoice()` / `sendFile()` (deliver outbound messages).

```bash
aibroker create-adapter my-signal
cd my-signal
claude  # paste the onboarding prompt and answer 5 questions
```

Full guide: [docs/CREATE_ADAPTER.md](docs/CREATE_ADAPTER.md)

---

## Bring Your Own AI

Configure a built-in provider (Anthropic, OpenAI, Ollama) or implement the `Backend` interface in any Node.js module:

```json
{
  "backend": {
    "type": "api",
    "provider": "ollama",
    "model": "llama3.2"
  }
}
```

```json
{
  "backend": {
    "type": "custom",
    "modulePath": "/path/to/my-backend.js",
    "options": { "model": "my-model" }
  }
}
```

Full guide: [docs/BACKEND_GUIDE.md](docs/BACKEND_GUIDE.md)

---

## What's Inside

- Logging with configurable prefix (`setLogPrefix`)
- Session state management and message queuing
- File persistence with configurable data dir (`setAppDir`)
- Unix Domain Socket IPC (server + client)
- macOS iTerm2 adapter (AppleScript session management)
- Kokoro TTS (local speech synthesis + Whisper transcription)
- PAILot WebSocket gateway (iOS companion app support)

---

## Usage as a Library

```typescript
import { setLogPrefix, setAppDir, log } from "aibroker";

setLogPrefix("my-app");
setAppDir("/path/to/data");

log("my-app started");
```

The IPC client:

```typescript
import { WatcherClient } from "aibroker";

const client = new WatcherClient("/tmp/my-adapter-watcher.sock");
const result = await client.call_raw("health", {});
console.log(result);
```

---

## Hard Rule

aibroker never imports `@whiskeysockets/baileys`, `telegram`/`gramjs`,
`better-sqlite3`, `qrcode`, or any transport SDK. Those belong in
the per-channel packages.

---

## Family

| Package | Channel | Repo |
|---------|---------|------|
| **aibroker** | Shared core | [github.com/mnott/AIBroker](https://github.com/mnott/AIBroker) |
| **whazaa** | WhatsApp | [github.com/mnott/Whazaa](https://github.com/mnott/Whazaa) |
| **telex** | Telegram | [github.com/mnott/Telex](https://github.com/mnott/Telex) |

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — Matthias Nott
