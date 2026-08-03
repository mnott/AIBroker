# AIBroker Documentation

AIBroker is a standalone daemon that acts as the central hub for AI message routing on macOS. It connects messaging transports (WhatsApp, Telegram, PAILot mobile app), terminal sessions (iTerm2/Claude Code), TTS/STT pipelines, image generation, and MCP tooling through a single, addressable routing fabric called AIBP.

## What AIBroker Is

AIBroker is the **runtime**. Adapters (Whazaa for WhatsApp, Telex for Telegram) are thin transport plugins that cannot function without it. The daemon owns:

- The hub IPC socket at `/tmp/aibroker.sock`
- The PAILot MQTT broker on port 8765 (aedes, in-process)
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
- [Channels](./channels.md) — **Start here for anything inbound.** The model Todoist, PAILot, the HTTP endpoint and the messenger adapters all share: who the addressee is, why the payload never names it, delivery modes, catch-up, loop safety

### Inbound Channels

- [Task manager as interface](./task-manager-as-interface.md) — **Start here if you want the idea, not the setup.** What it feels like to delegate to an AI from Todoist, and what it deliberately will not do
- [Todoist](./todoist.md) — File work from a phone or watch; ingress grants, triggers, the comment mirror
- [Inbound routes](./inbound.md) — `POST /hook/<route>`: anything that speaks HTTP reaching a session
- [Mailbox](./mailbox.md) — The durable per-session queue, confirmed delivery, the drain hook
- [Audit trail](./audit.md) — What happened, who caused it, and what was refused
- [Outbound](./outbound.md) — Acting in Stripe, HubSpot, Salesforce and the rest through a platform's own actions, with no connector written here

### Plugin System

- [Plugins](./plugins.md) — Plugin types, registration, lifecycle, heartbeat
- [Adapters](./adapters.md) — Transport adapters: what they own, how they connect, how to write one
- [Sessions](./sessions.md) — HybridSessionManager, session discovery, switching, StatusCache

### Interfaces

- [Commands](./commands.md) — All slash commands with examples
- [MCP Tools](./mcp-tools.md) — All MCP tool definitions with parameters and examples
- [IPC Protocol](./ipc.md) — Unix socket protocol, all handlers, request/response format

### Transport Layers

- [PAILot](./pailot.md) — Mobile app over MQTT, APNs push, voice pipeline, session management
- [Mesh](./mesh.md) — Multi-machine bridge networking

### Voice & Media

- [TTS and STT](./tts-stt.md) — Kokoro TTS, Whisper STT, voice pipeline

### Developer Reference

- [Use Cases](./use-cases.md) — Complete message flow diagrams for 14 scenarios, including Todoist ingress, inbound routes, the comment mirror and session-to-session hand-off
- [Development](./development.md) — Setup, build, test, conventions, patterns
- [Backends](./backends.md) — Adding an AI backend
- [Creating an adapter](./create-adapter.md) — Scaffolding a new transport adapter
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

## Current version

**v0.26.0** — AIBP routing layer active; iTerm2 and tmux are registered terminal
plugins. PAILot runs over an in-process MQTT broker with APNs push. Todoist is a
full inbound channel with ingress grants, triggers and a bidirectional comment
mirror. A generic HTTP endpoint (`/hook/<route>`) lets any external system reach
a session. Cross-session messaging is durable through the mailbox, and every
cross-boundary action is audited.

## Keeping this honest

Docs drift, and silently wrong documentation is worse than none — on 2026-08-03
thirteen files still described PAILot as a WebSocket gateway, five months after
it moved to MQTT. If you change a transport, a port, a topic or a delivery
guarantee, grep `docs/` for the old fact before you finish. Diagrams count.

See [Notes/TODO.md](../Notes/TODO.md) for what is implemented vs. what is planned.
