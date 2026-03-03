# aibroker

Platform-agnostic AI message broker — shared infrastructure for messaging
bridges that connect WhatsApp, Telegram, and other channels to Claude Code.

## Family

| Package | Channel | Repo |
|---------|---------|------|
| **aibroker** | Shared core | [github.com/mnott/AIBroker](https://github.com/mnott/AIBroker) |
| **whazaa** | WhatsApp | [github.com/mnott/Whazaa](https://github.com/mnott/Whazaa) |
| **telex** | Telegram | [github.com/mnott/Telex](https://github.com/mnott/Telex) |

## What's Inside

- Logging with configurable prefix (`setLogPrefix`)
- Session state management and message queuing
- File persistence with configurable data dir (`setAppDir`)
- Unix Domain Socket IPC (server + client)
- macOS iTerm2 adapter (AppleScript session management)
- Kokoro TTS (local speech synthesis + Whisper transcription)

## Usage

```typescript
import { setLogPrefix, setAppDir } from "aibroker";

setLogPrefix("my-app");
setAppDir("/path/to/data");
```

## Hard Rule

aibroker never imports `@whiskeysockets/baileys`, `telegram`/`gramjs`,
`better-sqlite3`, `qrcode`, or any transport SDK. Those belong in
the per-channel packages.

## License

MIT — Matthias Nott
