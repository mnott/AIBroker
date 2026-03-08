# Architecture

## System Overview

AIBroker is a macOS-resident daemon that acts as the central routing hub for AI-assisted messaging. Its purpose is to connect the user's messaging apps (WhatsApp, Telegram, a native iOS app called PAILot) to Claude Code sessions running inside iTerm2 terminals, while also owning voice, image, and command handling.

```
┌─────────────────────────────────────────────────────────────┐
│                     AIBroker Daemon                         │
│                                                             │
│  ┌──────────┐  ┌────────────┐  ┌──────────────────────┐    │
│  │  AIBP    │  │ Hybrid     │  │  Hub Command Handler  │    │
│  │ Registry │  │ Session    │  │  (slash commands)     │    │
│  │ (routing)│  │ Manager    │  │                       │    │
│  └────┬─────┘  └────────────┘  └──────────────────────┘    │
│       │                                                     │
│  ┌────▼─────────────────────────────────────────────────┐   │
│  │                    IPC Server                        │   │
│  │              /tmp/aibroker.sock                      │   │
│  └────────────────────────┬─────────────────────────────┘  │
│                           │                                 │
│  ┌────────────────────────▼───────────────────────────┐    │
│  │               Subsystems                           │    │
│  │  TTS (Kokoro)  STT (Whisper)  Image Gen (Replicate)│    │
│  │  Screenshot    Session Content  Status Cache       │    │
│  └────────────────────────────────────────────────────┘    │
│                                                             │
│  ┌────────────────────────────────────────────────────┐    │
│  │         PAILot WebSocket Gateway (:8765)           │    │
│  └────────────────────────────────────────────────────┘    │
└──────────────┬──────────────────────────────────────────────┘
               │ IPC (Unix sockets)
    ┌──────────┴───────────┐
    │                      │
┌───▼────┐           ┌─────▼────┐
│ Whazaa │           │  Telex   │
│(Baileys│           │ (gramjs) │
│ /WA)   │           │ /Tg)     │
└───┬────┘           └─────┬────┘
    │                      │
WhatsApp               Telegram
Network                Network

                    ┌──────────────┐
                    │   PAILot iOS │
                    │   App (WS)   │
                    └──────────────┘

                    ┌──────────────┐
                    │  Claude Code │
                    │  MCP Server  │──── dist/mcp/index.js
                    │  (stdio)     │
                    └──────────────┘

                    ┌──────────────┐
                    │   iTerm2     │
                    │  Sessions    │──── AppleScript
                    └──────────────┘
```

## Component Descriptions

### AIBroker Daemon

The daemon (`src/daemon/index.ts`) is the entry point. It starts all subsystems and keeps them running:

- Creates the `IpcServer` on `/tmp/aibroker.sock`
- Creates the `AibpBridge` (AIBP routing layer)
- Registers PAILot as a `mobile` plugin in AIBP
- Registers the hub's session handler as a `hub` plugin
- Registers iTerm2 as a `terminal` plugin
- Starts the PAILot WebSocket gateway on port 8765
- Auto-discovers running adapters (Whazaa, Telex) via their sockets
- Starts the `HybridSessionManager` and `APIBackend`
- Loads persisted state (session registry, voice config)
- Handles SIGINT/SIGTERM gracefully

### AIBP Registry (src/aibp/registry.ts)

The routing brain. It maintains:
- A map of registered plugins (address → connection + sendFn)
- A map of channels (name → membership set + outbox)
- A map of registered commands (name → owning plugin address)

Every message goes through `registry.route(msg)`. The routing algorithm is documented in [routing.md](./routing.md).

### AIBP Bridge (src/aibp/bridge.ts)

Integration layer between legacy IPC and the AIBP registry. Provides typed convenience methods (`registerMobile`, `registerTransport`, `routeFromMobile`, `routeToMobile`, etc.) rather than raw `PluginSpec` assembly. The bridge is the public API that the rest of the system uses; the registry is the implementation.

### IPC Server (src/ipc/server.ts)

Unix Domain Socket server using NDJSON as the wire format. Each connection handles exactly one request/response pair and then closes. Handlers are registered with `server.on(method, handler)`. The server auto-registers unknown sessions and enriches requests with `sessionId` and optional `itermSessionId`.

### Hub Command Handler (src/daemon/commands.ts)

Processes slash commands and plain text. Receives a `CommandContext` that abstracts the reply channel, so the same handler works whether a message came from WhatsApp, Telegram, or PAILot. Documented in [commands.md](./commands.md).

### HybridSessionManager (src/core/hybrid.ts)

Maintains a flat list of sessions that can be either `api` (headless Claude subprocess) or `visual` (iTerm2 tab). Supports creation, switching, removal, pruning dead sessions, and name synchronization.

### PAILot Gateway (src/adapters/pailot/gateway.ts)

WebSocket server on port 8765. Handles PAILot iOS app connections: structured commands (sync, switch, rename, nav, screenshot), text messages, voice messages (M4A audio → Whisper transcription → AIBP routing), and image uploads. Maintains a per-session outbox for offline clients. Broadcasts to alive clients only (90-second liveness threshold).

### MCP Server (src/mcp/index.ts)

Unified MCP server (42 tools) that Claude Code connects to. Connects to the daemon via `/tmp/aibroker.sock`. Proxies WhatsApp and Telegram tool calls to the respective adapters via `adapter_call`. Owns hub-level tools directly (`aibroker_*`). Documented in [mcp-tools.md](./mcp-tools.md).

### Kokoro TTS (src/adapters/kokoro/tts.ts)

Local TTS pipeline: Kokoro-js ONNX model → Float32 PCM → WAV → ffmpeg → OGG Opus. No network calls. Supports 28 voices across American and British accents (female: af_*, bf_*; male: am_*, bm_*).

### Status Cache (src/core/status-cache.ts)

In-memory cache of AI-parsed session summaries, keyed by iTerm2 session ID. Supports content hashing for change detection. Used by `aibroker_session_content` and `aibroker_cache_status` MCP tools for the session orchestration workflow.

## Data Flow: Message In

```
User speaks into PAILot
        │
        ▼
PAILot WS Gateway (gateway.ts)
        │ M4A audio bytes
        ▼
Whisper transcription
        │ transcript text
        ▼
AIBP Bridge routeFromMobile()
        │ AibpMessage TEXT, src=mobile:pailot, dst=session:UUID
        ▼
AIBP Registry route()
        │ fan-out to session channel members
        ▼
Hub Session Handler (registered as hub:session-handler)
        │ dispatches to hubCommandHandler()
        ▼
deliverMessage() → typeIntoSession() → AppleScript → iTerm2
        │
Claude Code processes the message
```

## Data Flow: Message Out

```
Claude calls pailot_send MCP tool
        │
        ▼
MCP Server hub.call_raw("pailot_send", ...)
        │
        ▼
IPC Server → pailot_send handler
        │
        ▼
AIBP Bridge routeToMobile()
        │ AibpMessage TEXT, src=session:UUID, dst=mobile:pailot
        ▼
AIBP Registry route() → delivers to mobile:pailot plugin
        │
        ▼
PAILot plugin callback → broadcastText()
        │
        ▼
WebSocket broadcast to alive clients → PAILot app displays message
```

## Design Principles

### Adapters Own Only the Network

Adapters (Whazaa, Telex) own exactly two things: (1) the network connection to the messaging platform, and (2) forwarding bytes in both directions. No commands, no session management, no TTS, no routing logic. This is enforced as a hard rule: adapters require the hub and cannot function without it.

### Explicit Addressing

Every AIBP message has a `src` and `dst`. No implicit routing. No "current active session" guessing inside the protocol layer. The IRC design principle: if you don't know where a message goes, you don't send it.

### Registry as Single Truth

The AIBP registry is the single source of truth for what plugins are connected, what channels exist, and what messages are buffered. The `AibpBridge` is a convenience wrapper; direct registry access is reserved for the bridge itself.

### CommandContext for Transport Independence

The hub command handler never calls transport-specific functions. It receives a `CommandContext` with `reply()`, `replyImage()`, and `replyVoice()` methods that are wired by the caller to the originating adapter. This makes the same command handler usable from WhatsApp, Telegram, PAILot, and future transports.

### Outbox for Offline Tolerance

Both the AIBP registry (for plugin channels) and the PAILot gateway (for WebSocket clients) maintain outboxes that buffer messages when the recipient is offline. Messages are drained when the plugin reconnects or the client sends a `sync` command.

### launchd for Process Management

The daemon is managed by macOS launchd, not a custom process supervisor. Environment variables are loaded from `~/.aibroker/env` at startup so API tokens do not appear in the plist.

## The IRC Analogy in Depth

In IRC, a user connects to a server with a nick. They join channels. Messages sent to a channel are delivered to all members. If a user is offline, their client misses the message (unless a bouncer buffers it).

In AIBroker:
- A **plugin** is a user with a nick (its address: `transport:whazaa`, `mobile:pailot`, etc.)
- A **session channel** (`session:UUID`) is a channel that exactly one iTerm2 session belongs to
- The **hub** is the IRC server, routing all messages
- The **AIBP registry** is the IRC server's routing table
- The **outbox** is the IRC bouncer's message buffer
- The **bridge** plugin is the IRC server link (connecting two hub instances, like two IRC servers in a network)

This analogy is intentional. IRC's design is proven at scale for message routing with explicit addressing, and it maps cleanly onto the AIBroker problem domain.
