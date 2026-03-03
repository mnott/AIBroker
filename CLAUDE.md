# AIBroker

Shared infrastructure library for Whazaa (WhatsApp) and Telex (Telegram) MCP bridges.

## Build

```bash
npm install
npm run build    # tsc -> dist/
```

## Architecture

- Platform-agnostic modules: logging, state, persistence, IPC, TTS, dictation, media, iTerm2
- Consumed by Whazaa and Telex as npm dependency (`aibroker@^0.1.0`)
- For local development: `npm link` in this repo, `npm link aibroker` in consumer repos

## Hard Rules

- NEVER import: baileys, gramjs, better-sqlite3, qrcode (platform-specific deps stay in consumers)
- npm package: `aibroker` (unscoped, public)
- Changes here affect both Whazaa and Telex — test both after modifications
