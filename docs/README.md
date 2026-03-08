# AIBroker Documentation

AIBroker is a standalone daemon that acts as the central hub for AI message routing on macOS. It connects messaging transports (WhatsApp, Telegram, PAILot mobile app), terminal sessions (iTerm2/Claude Code), TTS/STT pipelines, image generation, and MCP tooling through a single, addressable routing fabric called AIBP.

## What AIBroker Is

AIBroker is the **runtime**. Adapters (Whazaa for WhatsApp, Telex for Telegram) are thin transport plugins that cannot function without it. The daemon owns:

- The hub IPC socket at `/tmp/aibroker.sock`
- The PAILot WebSocket gateway on port 8765
- All slash commands (`/ss`, `/s`, `/h`, `/cc`, etc.)
- Session management (visual iTerm2 tabs + headless API sessions)
- The TTS pipeline (Kokoro) and STT pipeline (Whisper)
- Image generation (Replicate Flux)
- The unified MCP server that Claude Code connects to
- The AIBP protocol routing layer

## The IRC Analogy

AIBroker's internal architecture is inspired by IRC:

| IRC concept | AIBroker equivalent |
|-------------|---------------------|
| User | A human user with a device |
| Connection | A plugin (transport, terminal, mobile, mcp) |
| Channel | A session channel (`session:UUID`) or transport channel |
| Hub/Server | The AIBroker daemon |
| Bridge | A bridge plugin linking two daemon instances |
| Nick | Plugin address (`transport:whazaa`, `mobile:pailot`, etc.) |

Messages are sent to explicit addresses. The registry fans them out. Plugins join channels. Offline plugins have messages buffered in outboxes. This is IRC, adapted for AI.

## Document Index

### Core Concepts

- [Architecture](./architecture.md) — System overview, component diagram, design principles
- [Protocol](./protocol.md) — AIBP message envelope, types, addressing, wire format
- [Routing](./routing.md) — How messages flow from source to destination

### Plugin System

- [Plugins](./plugins.md) — Plugin types, registration, lifecycle, heartbeat
- [Adapters](./adapters.md) — Transport adapters: what they own, how they connect, how to write one
- [Sessions](./sessions.md) — HybridSessionManager, session discovery, switching, StatusCache

### Interfaces

- [Commands](./commands.md) — All slash commands with examples
- [MCP Tools](./mcp-tools.md) — All MCP tool definitions with parameters and examples
- [IPC Protocol](./ipc.md) — Unix socket protocol, all handlers, request/response format

### Transport Layers

- [PAILot](./pailot.md) — Mobile app WebSocket gateway, voice pipeline, session management
- [Mesh](./mesh.md) — Multi-machine bridge networking

### Voice & Media

- [TTS and STT](./tts-stt.md) — Kokoro TTS, Whisper STT, voice pipeline

### Developer Reference

- [Use Cases](./use-cases.md) — Complete message flow diagrams for 10 scenarios
- [Development](./development.md) — Setup, build, test, conventions, patterns
- [Configuration](./configuration.md) — All config files, env vars, launchd

## Quick Start

```bash
# Build
npm install && npm run build

# Start the daemon
node dist/daemon/cli.js start

# Check status
node dist/daemon/cli.js status
```

The daemon registers adapters automatically when they start. Adapters find the hub at `/tmp/aibroker.sock`. The MCP server starts as a subprocess of Claude Code via `~/.claude.json`.

## Current Version

**v0.6.1** — AIBP protocol routing layer active. All PAILot messages route through the AIBP registry. iTerm2 is a registered terminal plugin. Cross-session messaging and mesh networking are implemented.

See [Notes/TODO.md](../Notes/TODO.md) for what is implemented vs. what is planned.
