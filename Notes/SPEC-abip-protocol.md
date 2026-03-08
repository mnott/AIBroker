# ABIP — AIBroker Interchange Protocol

**Version:** 0.1 (draft)
**Date:** 2026-03-08
**Status:** Specification — not yet implemented

---

## 1. Overview

ABIP is the internal message protocol that structures all communication inside
an AIBroker hub. Today the hub speaks an ad-hoc mix of NDJSON over Unix Domain
Sockets (IPC), JSON over WebSocket (PAILot gateway), and AppleScript side
effects (iTerm). ABIP replaces this with a single, coherent addressing model
that borrows the discipline of IRC without copying its wire format.

### What IRC Gets Right

IRC has survived 35 years because of four principles:

1. Every message has an explicit source and target — no implicit "current chat."
2. Channels are named namespaces that clients join and part explicitly.
3. Plugins (services, bots) register with the server and declare capabilities.
4. Server-to-server linking lets networks span multiple physical hosts.

ABIP applies these principles to a personal AI infrastructure hub where the
"users" are human-operated apps (PAILot), AI agents (Claude Code sessions),
and platform transports (WhatsApp, Telegram).

### What We Don't Copy from IRC

- IRC is newline-delimited text. ABIP is newline-delimited JSON (NDJSON).
- IRC channel names are flat (`#channel`). ABIP channels are namespaced
  (`session:<id>`, `transport:<name>`, `hub:<machine>`).
- IRC authentication is a bolt-on. ABIP authentication is first-class for
  plugin registration and hub-to-hub links.

---

## 2. Core Concepts

### Hub

The Hub is a single AIBroker daemon process. It owns:

- The plugin registry (what plugins are connected and what they can do)
- The channel registry (what sessions/channels exist and who has joined them)
- The message router (gets a message from A, delivers it to B)
- The outbox (buffers messages for offline recipients)
- The command registry (maps `/command` strings to handler plugins)

One daemon = one hub. Hub identity is `hub:<hostname>` by default (e.g.,
`hub:mbp`). Mesh links connect two hubs.

### Plugin

A Plugin is any process that connects to the hub and registers itself. Plugins
replace what the codebase currently calls "adapters," "clients," and "watchers."
Plugin types:

| Type | Examples | Connects via |
|------|----------|-------------|
| `transport` | Whazaa (WhatsApp), Telex (Telegram) | Unix socket (IPC) |
| `terminal` | iTerm2, future terminals | Unix socket (IPC) |
| `mobile` | PAILot iOS app | WebSocket |
| `bridge` | Remote AIBroker hub | WebSocket |
| `mcp` | Claude Code MCP process | Unix socket (IPC) |

All plugins use the same ABIP message format regardless of transport.

### Channel

A Channel is a named, persistent message stream. Channels replace what the
codebase calls "sessions" in some places and "chats" in others.

Channel naming convention:

```
session:<uuid>          # A Claude Code terminal session
transport:whatsapp      # All WhatsApp messages (broadcast channel)
transport:telegram      # All Telegram messages
hub:<hostname>          # Messages from/to a remote hub
dm:<id>                 # Direct messages to a specific WhatsApp/Telegram contact
```

Plugins JOIN channels to receive messages from them and PART to stop.

### User

A User is an addressable entity that can send and receive messages. User types:

| Type | Address Format | Example |
|------|---------------|---------|
| Human (local) | `user:local` | The mac user |
| AI session | `session:<iterm-uuid>` | `session:ABC123` |
| Mobile app | `mobile:pailot` | PAILot app |
| WhatsApp contact | `wa:<jid>` | `wa:+41791234567@s.whatsapp.net` |
| Telegram contact | `tg:<id>` | `tg:123456789` |
| Remote hub | `hub:<hostname>` | `hub:mac-mini` |

### Message

The Message is the unit of communication. Every message has source, target,
type, and payload. Messages are never implicit — the hub always knows where
a message came from and where it is going.

---

## 3. Message Format

All messages are JSON objects, one per line (NDJSON), terminated with `\n`.
This matches the existing IPC protocol and WebSocket framing.

### Envelope

Every ABIP message has this envelope:

```json
{
  "abip": "0.1",
  "id": "<uuid>",
  "ts": 1709900000000,
  "src": "<address>",
  "dst": "<address>",
  "type": "<MESSAGE_TYPE>",
  "payload": {}
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `abip` | string | yes | Protocol version for forward compat |
| `id` | string | yes | UUID, unique per message |
| `ts` | number | yes | Unix epoch milliseconds |
| `src` | string | yes | Sender address |
  `dst` | string | yes | Destination address or channel name |
| `type` | string | yes | Message type (see below) |
| `payload` | object | yes | Type-specific content |

### Message Types

```
TEXT       — Plain text content
VOICE      — Audio content (base64) with transcript
IMAGE      — Image content (base64) with optional caption
COMMAND    — A /command invocation
SYSTEM     — Hub-internal signals (JOIN, PART, ACK, ERROR, etc.)
TYPING     — Typing indicator (start/stop)
STATUS     — Session/plugin status update
FILE       — Binary file transfer (path or base64)
```

### TEXT Message

```json
{
  "abip": "0.1",
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "ts": 1709900000000,
  "src": "mobile:pailot",
  "dst": "session:ABC123",
  "type": "TEXT",
  "payload": {
    "content": "What's the status of the build?"
  }
}
```

### VOICE Message

```json
{
  "abip": "0.1",
  "id": "550e8400-e29b-41d4-a716-446655440001",
  "ts": 1709900000000,
  "src": "mobile:pailot",
  "dst": "session:ABC123",
  "type": "VOICE",
  "payload": {
    "audioBase64": "<m4a base64>",
    "transcript": "What is the status of the build",
    "transcriptConfidence": 0.97,
    "durationMs": 2300
  }
}
```

### IMAGE Message

```json
{
  "abip": "0.1",
  "id": "550e8400-e29b-41d4-a716-446655440002",
  "ts": 1709900000000,
  "src": "mobile:pailot",
  "dst": "session:ABC123",
  "type": "IMAGE",
  "payload": {
    "imageBase64": "<jpeg base64>",
    "mimeType": "image/jpeg",
    "caption": "Here's the error screenshot"
  }
}
```

### COMMAND Message

```json
{
  "abip": "0.1",
  "id": "550e8400-e29b-41d4-a716-446655440003",
  "ts": 1709900000000,
  "src": "session:ABC123",
  "dst": "hub:local",
  "type": "COMMAND",
  "payload": {
    "command": "sessions",
    "args": {}
  }
}
```

### SYSTEM Message

```json
{
  "abip": "0.1",
  "id": "550e8400-e29b-41d4-a716-446655440004",
  "ts": 1709900000000,
  "src": "hub:local",
  "dst": "session:ABC123",
  "type": "SYSTEM",
  "payload": {
    "event": "JOIN_ACK",
    "channel": "session:ABC123",
    "data": {}
  }
}
```

System events: `JOIN`, `JOIN_ACK`, `PART`, `PART_ACK`, `REGISTER`, `REGISTER_ACK`,
`ERROR`, `PING`, `PONG`, `SHUTDOWN`, `OUTBOX_DRAIN`.

### TYPING Message

```json
{
  "abip": "0.1",
  "id": "550e8400-e29b-41d4-a716-446655440005",
  "ts": 1709900000000,
  "src": "session:ABC123",
  "dst": "mobile:pailot",
  "type": "TYPING",
  "payload": {
    "active": true
  }
}
```

### STATUS Message

```json
{
  "abip": "0.1",
  "id": "550e8400-e29b-41d4-a716-446655440006",
  "ts": 1709900000000,
  "src": "hub:local",
  "dst": "mobile:pailot",
  "type": "STATUS",
  "payload": {
    "subject": "session:ABC123",
    "state": "busy",
    "summary": "Running npm test"
  }
}
```

---

## 4. Plugin Protocol

### Registration Handshake

When a plugin connects (Unix socket or WebSocket), it must register within
5 seconds or the hub closes the connection.

**Step 1: Plugin sends REGISTER**

```json
{
  "abip": "0.1",
  "id": "<uuid>",
  "ts": 1709900000000,
  "src": "plugin:whazaa",
  "dst": "hub:local",
  "type": "SYSTEM",
  "payload": {
    "event": "REGISTER",
    "plugin": {
      "id": "whazaa",
      "type": "transport",
      "name": "WhatsApp (Whazaa)",
      "version": "0.7.0",
      "capabilities": ["TEXT", "VOICE", "IMAGE", "FILE"],
      "channels": ["transport:whatsapp"],
      "commands": [
        {
          "name": "wa",
          "description": "Send a WhatsApp message",
          "args": "send <recipient> <message>"
        }
      ]
    },
    "auth": {
      "token": "<pre-shared token or empty for local UDS>"
    }
  }
}
```

**Step 2: Hub sends REGISTER_ACK**

```json
{
  "abip": "0.1",
  "id": "<uuid>",
  "ts": 1709900000000,
  "src": "hub:local",
  "dst": "plugin:whazaa",
  "type": "SYSTEM",
  "payload": {
    "event": "REGISTER_ACK",
    "assignedAddress": "transport:whatsapp",
    "hubVersion": "0.1",
    "peers": ["transport:telegram", "mobile:pailot"]
  }
}
```

If registration fails (bad token, duplicate ID, capability conflict):

```json
{
  "type": "SYSTEM",
  "payload": {
    "event": "ERROR",
    "code": "REGISTER_REJECTED",
    "reason": "Plugin ID already registered"
  }
}
```

### Plugin Lifecycle

```
connect → REGISTER → REGISTER_ACK → [JOIN channels] → running
                                                        ↓
                                              PING/PONG heartbeat
                                                        ↓
                                              graceful: PART → disconnect
                                              crash: hub detects dead socket
                                                     → cleans up registry
                                                     → notifies joined channels
```

### Capability Declaration

Capabilities tell the hub what message types a plugin can handle and produce.
The hub uses this to reject ill-addressed messages before delivery.

```typescript
interface PluginCapabilities {
  can_receive: MessageType[];   // What types the plugin handles
  can_produce: MessageType[];   // What types the plugin emits
  channels: string[];           // Channels this plugin manages or joins
  commands: CommandSpec[];      // /commands this plugin provides
}
```

### Heartbeat

Plugins send PING every 30 seconds. Hub replies with PONG. If a plugin misses
3 consecutive heartbeats (90 seconds), the hub marks it `degraded`. After 5
missed heartbeats (150 seconds), the hub removes the plugin from the registry
and sends `SYSTEM ERROR: PLUGIN_TIMEOUT` to all joined channels.

```json
{
  "type": "SYSTEM",
  "payload": { "event": "PING", "uptime": 3600 }
}
```

```json
{
  "type": "SYSTEM",
  "payload": { "event": "PONG", "ts": 1709900000000 }
}
```

---

## 5. Channel (Session) Management

### JOIN

A plugin must JOIN a channel to receive messages from it.

Plugin sends:
```json
{
  "type": "SYSTEM",
  "payload": { "event": "JOIN", "channel": "session:ABC123" }
}
```

Hub replies:
```json
{
  "type": "SYSTEM",
  "payload": {
    "event": "JOIN_ACK",
    "channel": "session:ABC123",
    "members": ["session:ABC123", "mobile:pailot"]
  }
}
```

### PART

```json
{
  "type": "SYSTEM",
  "payload": { "event": "PART", "channel": "session:ABC123", "reason": "session closed" }
}
```

### LIST

```json
{
  "type": "COMMAND",
  "payload": { "command": "list_channels", "args": {} }
}
```

Hub returns all channels with member counts and last activity timestamps.

### Channel Naming Rules

- `session:<uuid>` — One-to-one: a Claude Code terminal session. UUID is the
  iTerm session ID for visual sessions or a generated UUID for API sessions.
- `transport:<name>` — Broadcast: all messages from a transport plugin.
  Multiple plugins can subscribe; hub fans out.
- `dm:<address>` — Direct conversation with a specific external contact
  (`dm:wa:+41791234567@s.whatsapp.net`).
- `hub:<hostname>` — Inter-hub messages from a remote mesh peer.

Channel names are globally unique within a hub. They do not need `#` prefixes
(IRC convention) because the namespace prefix makes type explicit.

### Unread Tracking

The hub tracks per-member read position (last message ID seen) per channel.
When a plugin JOINs a channel it previously PARTed, the hub reports unread count:

```json
{
  "type": "SYSTEM",
  "payload": {
    "event": "JOIN_ACK",
    "channel": "session:ABC123",
    "unreadCount": 3,
    "oldestUnreadId": "<uuid>"
  }
}
```

### Outbox / Scrollback

The hub buffers up to 50 messages per channel for offline members (plugins
that have registered but are currently disconnected, or mobile clients in
background). On reconnect, the hub delivers a SYSTEM `OUTBOX_DRAIN` event
followed by the buffered messages in timestamp order.

```json
{
  "type": "SYSTEM",
  "payload": {
    "event": "OUTBOX_DRAIN",
    "channel": "session:ABC123",
    "count": 3,
    "summary": "3 text messages while offline"
  }
}
```

This replaces the current ad-hoc `addToOutbox`/`drainOutbox` in gateway.ts
with a protocol-level primitive.

---

## 6. Command System

### /command Syntax

Users type `/command [args]` in any client. The client wraps it in a COMMAND
message and sends it to `hub:local`. The hub looks up the command in the
command registry and routes to the owning plugin.

Commands are scoped to plugins. The hub's built-in commands have priority.
Plugin commands are prefixed with the plugin's namespace:

```
/sessions          # built-in (hub)
/switch <id>       # built-in (hub)
/rename <id> <n>   # built-in (hub)
/help              # built-in (hub)
/status            # built-in (hub, from session-orchestration design)
/wa send <r> <m>   # plugin:whazaa
/tg send <r> <m>   # plugin:telex
```

### Command Registration

Plugins declare commands during REGISTER (see section 4). The hub merges these
into its command registry. On name collision, the hub rejects the second plugin's
registration unless the command is namespaced differently.

### CommandSpec

```typescript
interface CommandSpec {
  name: string;              // e.g. "wa"
  description: string;       // shown in /help
  args: string;              // usage string: "send <recipient> <message>"
  subcommands?: CommandSpec[]; // for grouped commands like /wa send, /wa history
}
```

### Command Dispatch Flow

```
User types: /wa send +41791234567 Hello
  │
  ├── Client wraps in COMMAND { command: "wa", args: { sub: "send", recipient: "+41...", message: "Hello" } }
  ├── Sends to hub:local
  │
  ├── Hub looks up "wa" → owned by plugin:whazaa
  ├── Hub forwards COMMAND to plugin:whazaa dst
  │
  ├── plugin:whazaa executes, sends TEXT reply back to hub
  └── Hub routes reply to originating session/client
```

### Built-in Commands

| Command | Description |
|---------|-------------|
| `/sessions` | List all active sessions with status |
| `/switch <id\|name>` | Switch active session |
| `/rename <id> <name>` | Rename a session |
| `/status [session]` | Get session status (ties to session-orchestration design) |
| `/help [command]` | Show command help |
| `/plugins` | List registered plugins and capabilities |
| `/join <channel>` | Join a channel |
| `/part <channel>` | Leave a channel |

---

## 7. Server-to-Server (Mesh)

### Hub Link Protocol

A remote AIBroker hub connects as a `bridge` plugin. Unlike transport plugins,
bridge plugins have bidirectional authority — they can both receive messages
and inject messages on behalf of remote sessions.

**Initiator (MacBook primary hub):**

```json
{
  "type": "SYSTEM",
  "payload": {
    "event": "REGISTER",
    "plugin": {
      "id": "bridge-mac-mini",
      "type": "bridge",
      "name": "Mac Mini Hub",
      "remoteHubId": "hub:mac-mini",
      "capabilities": ["TEXT", "VOICE", "IMAGE", "COMMAND", "STATUS"]
    },
    "auth": {
      "token": "<pre-shared secret>"
    }
  }
}
```

### Remote Session Addressing

When a hub is linked, its sessions become addressable from the primary hub
using a `<hub>:<address>` prefix:

```
hub:mac-mini/session:DEF456   — session DEF456 on the Mac Mini
hub:mac-mini/transport:whatsapp — not meaningful (transport is local-only)
```

### Message Routing Across Hubs

```
session:ABC123 (MacBook) sends TEXT to hub:mac-mini/session:DEF456
  │
  ├── MacBook hub: dst starts with "hub:mac-mini/" → route to bridge plugin
  ├── Bridge plugin: forward message to Mac Mini hub over WebSocket
  ├── Mac Mini hub: strip hub prefix, deliver to session:DEF456
  └── session:DEF456 receives TEXT as if it came from session:ABC123
```

The original `src` address is preserved through the hop. The Mac Mini hub does
not rewrite `src` to the bridge plugin.

### Hub Authentication

Pre-shared token only (no certificate exchange in v0.1). Token is configured
in `~/.aibroker/env` on both machines:

```
ABIP_MESH_TOKEN=<shared-secret>
ABIP_MESH_PEERS=ws://mac-mini.local:8766
```

Bridge connections use wss:// for remote WAN links; ws:// is acceptable on
LAN where network-level security exists.

### Session Sharing Scope

In v0.1, remote hubs share only:
- Session list (names, IDs, states) — for display in PAILot
- TEXT, STATUS, COMMAND messages to/from specific sessions

Remote hubs do NOT share:
- Contact directories (stay local to each transport)
- Voice/audio (latency + bandwidth concern — routed as text transcript only)
- File transfers (address separately in a future spec)

---

## 8. Terminal Plugin

The current iTerm2 integration is hardcoded in `src/adapters/iterm/`. ABIP
formalizes it as a pluggable terminal plugin.

### Terminal Plugin Contract

A terminal plugin is responsible for:

1. **Session discovery** — enumerate running terminal sessions and report them
   to the hub as channels (`session:<id>`)
2. **Session creation** — open a new terminal session on request
3. **Input injection** — write text/keystrokes to a specific session
4. **Output capture** — read visible terminal content (last N lines) for status
5. **Lifecycle events** — report when sessions open, close, or go idle

### Terminal Plugin Commands (registered with hub)

```
/terminal sessions         # List terminal sessions
/terminal new [path]       # Open new session at optional path
/terminal kill <id>        # Close a session
/terminal content <id> [n] # Read last n lines of session output
/terminal focus <id>       # Bring session to foreground
```

### iTerm2 Provider

The iTerm2 concrete implementation uses AppleScript (as today). Future
terminals (Terminal.app, Ghostty, VS Code integrated terminal) would provide
their own plugin implementations without changing the ABIP protocol.

The current hardcoded `runAppleScript` calls in gateway.ts become private
implementation details of the iTerm2 terminal plugin. The hub calls
`/terminal content <id>` — it doesn't know or care that AppleScript is
executing underneath.

### Session Channel Lifecycle

When the terminal plugin detects a new iTerm session:
1. Plugin assigns it `session:<iterm-uuid>`
2. Plugin sends `SYSTEM JOIN` on behalf of the session to register the channel
3. Hub adds the channel to its registry

When a session closes:
1. Plugin sends `SYSTEM PART` with `reason: "session closed"`
2. Hub removes the channel and notifies joined members

---

## 9. MCP Integration

### MCP as a Plugin Type

Each Claude Code process spawns an MCP server process (`dist/mcp/index.js`).
Under ABIP, this MCP process registers as a `mcp` type plugin.

**Current identity problem:** The MCP process uses TTY detection and AppleScript
to figure out which iTerm session it belongs to (`detectSessionId()` in
mcp/index.ts). This is fragile and macOS-specific.

**ABIP solution:** The hub knows which session spawned which MCP process.
When an MCP plugin registers, it passes its `TERM_SESSION_ID` environment
variable. The hub cross-references this against the terminal plugin's session
registry to assign the correct `session:<id>` address. No TTY detection needed.

### MCP Registration

```json
{
  "type": "SYSTEM",
  "payload": {
    "event": "REGISTER",
    "plugin": {
      "id": "mcp-ABC123",
      "type": "mcp",
      "name": "Claude Code MCP",
      "sessionEnvId": "w4305:ABC123:..."
    }
  }
}
```

Hub responds with the resolved session address:
```json
{
  "type": "SYSTEM",
  "payload": {
    "event": "REGISTER_ACK",
    "assignedAddress": "mcp:ABC123",
    "resolvedSession": "session:ABC123"
  }
}
```

### MCP Tool Calls as COMMAND Messages

When Claude calls an MCP tool like `pailot_send`, the MCP plugin translates it
to an ABIP COMMAND message:

```json
{
  "src": "mcp:ABC123",
  "dst": "hub:local",
  "type": "COMMAND",
  "payload": {
    "command": "pailot_send",
    "args": { "message": "Build finished.", "sessionId": "ABC123" }
  }
}
```

The hub routes this to the PAILot mobile plugin, which broadcasts it to
connected clients. The MCP plugin receives a COMMAND reply with the result
and wraps it as an MCP tool response.

### Tool Namespace Mapping

| MCP tool prefix | Routes to |
|----------------|-----------|
| `aibroker_*` | hub:local built-ins |
| `whatsapp_*` | transport:whatsapp |
| `telegram_*` | transport:telegram |
| `pailot_*` | mobile:pailot |

This replaces the current `adapter_call` IPC pattern with direct ABIP routing.

---

## 10. Migration Path

### Phase 1: ABIP Envelope (non-breaking, additive)

**Goal:** Add ABIP envelope to all existing messages without changing behavior.
This establishes the addressing discipline while the underlying transports stay
the same.

Changes:
- `IpcRequest` and `IpcResponse` in `src/types/ipc.ts` grow optional `abip`,
  `src`, `dst` fields
- `IpcServer.dispatch()` logs unaddressed messages as warnings
- Gateway messages get `abip`, `src`, `dst` fields (ignored by clients initially)
- New `src/abip/envelope.ts` utility to wrap/unwrap the envelope

No behavior changes. No migration risk.

### Phase 2: Plugin Registry

**Goal:** Replace the ad-hoc handler map in `IpcServer` with a formal plugin
registry that understands capabilities and channels.

Changes:
- `src/abip/registry.ts` — PluginRegistry class
- REGISTER/REGISTER_ACK handshake replaces implicit connection accept
- Channel JOIN/PART replaces `setMessageSource()` + `activeClientId` heuristics
- Outbox moves from `gateway.ts` into the hub's channel layer
- Command registry replaces the switch-case in gateway.ts

Risk: Medium. The IPC server redesign touches core routing. Whazaa and Telex
need updates to send REGISTER payloads. Backwards-compat shim keeps old
clients working during transition.

### Phase 3: Terminal Plugin + MCP Identity

**Goal:** Extract iTerm coupling into a terminal plugin. Fix MCP session
identity via hub resolution.

Changes:
- `src/adapters/iterm/` becomes `src/plugins/terminal/iterm.ts`
- `gateway.ts` loses all AppleScript imports — calls `/terminal` commands instead
- MCP registration sends `sessionEnvId` and receives `resolvedSession`
- TTY detection code removed from `mcp/index.ts`

Risk: High. This changes the plugin boundary significantly. Implement behind a
feature flag (`ABIP_PHASE3=1`). iTerm plugin runs as a separate process or
in-process with the hub (start in-process for simplicity).

### What Does Not Change

- The WebSocket gateway for PAILot remains on port 8765 (ws protocol only
  changes the envelope format)
- The Unix Domain Socket at `/tmp/aibroker.sock` remains the hub connection
  point for local plugins
- Adapter repos (Whazaa, Telex) keep their existing watcher pattern; they just
  need to send REGISTER on connect
- The MCP tool names and schemas are unchanged (PAI skill files need no edits)

---

## 11. Wire Examples

### Example 1: PAILot User Sends Text to a Session

```
PAILot app           Hub                 session:ABC123
    │                  │                      │
    ├─ connect WS ────→│                      │
    ├─ REGISTER ───────→│                     │
    │←─ REGISTER_ACK ──┤                      │
    ├─ JOIN session:ABC123 ──→│               │
    │←─ JOIN_ACK ────────────┤               │
    │                  │                      │
    ├─ TEXT { dst: session:ABC123, │          │
    │         content: "Hi" } ────→│         │
    │                  ├─ route ──────────────→│
    │←─ TYPING { active: true } ──────────────┤ (Claude thinking)
    │←─ TEXT { content: "Hello!" } ───────────┤
```

The hub delivers both the TYPING and TEXT messages to PAILot because PAILot
has JOINed `session:ABC123`.

### Example 2: Claude Responds via MCP Tool

```
MCP process          Hub                 PAILot
    │                  │                   │
    ├─ COMMAND {       │                   │
    │   dst: hub:local,│                   │
    │   command: "pailot_send",            │
    │   args: { message: "Done." }         │
    │  } ─────────────→│                  │
    │                  ├─ route to ────────→│
    │                  │   mobile:pailot   │
    │                  │                   ├─ TEXT delivered to app
    │←─ COMMAND result─┤                   │
```

### Example 3: Cross-Session Status Query

```
session:ABC123       Hub                 session:DEF456
    │                  │                      │
    ├─ COMMAND {       │                      │
    │   command: "status",                   │
    │   args: { session: "DEF456" }          │
    │  } ─────────────→│                     │
    │                  ├─ /terminal content DEF456
    │                  │←─ raw output ────────┤ (terminal plugin reads iTerm)
    │←─ STATUS {       │                      │
    │   subject: session:DEF456,             │
    │   state: "busy",                       │
    │   summary: "Running npm test"          │
    │  } ─────────────│                      │
```

### Example 4: WhatsApp Message Arrives and Routes to Active Session

```
Whazaa plugin        Hub                 session:ABC123    PAILot
    │                  │                      │              │
    ├─ TEXT {          │                      │              │
    │   src: wa:+41791234567@s.whatsapp.net,  │              │
    │   dst: transport:whatsapp,              │              │
    │   content: "..."                        │              │
    │  } ─────────────→│                     │              │
    │                  ├─ fan-out: who is     │              │
    │                  │  subscribed to        │              │
    │                  │  transport:whatsapp?  │              │
    │                  ├─ route ──────────────→│ (active session)
    │                  ├─ route ─────────────────────────────→│ (PAILot if joined)
```

### Example 5: Mesh Routing (MacBook → Mac Mini)

```
session:ABC123       Hub:mbp             Hub:mac-mini      session:DEF456
(MacBook)            │                   │                  (Mac Mini)
    │                  │                   │                   │
    ├─ TEXT {          │                   │                   │
    │   dst: hub:mac-mini/session:DEF456  │                   │
    │  } ─────────────→│                  │                   │
    │                  ├─ forward to bridge→│                  │
    │                  │   (strip hub prefix)                  │
    │                  │                   ├─ route ───────────→│
    │                  │                   │                   ├─ processes message
    │                  │                   │←─ STATUS reply ───┤
    │←─ STATUS reply ──────────────────────┤                   │
```

### Example 6: Plugin Crash Recovery

```
Whazaa plugin        Hub
    │                  │
    ├─ (crash) ────────┤
    │  connection dead │
    │                  ├─ heartbeat timeout after 150s
    │                  ├─ remove plugin:whazaa from registry
    │                  ├─ SYSTEM ERROR to transport:whatsapp members:
    │                  │   { event: "PLUGIN_OFFLINE", plugin: "whazaa" }
    │                  │
    ├─ reconnect ──────→│ (Whazaa restarts via launchd)
    ├─ REGISTER ───────→│
    │←─ REGISTER_ACK ──┤ (hub delivers queued outbox)
```

---

## 12. TypeScript Interfaces (Reference)

These are the canonical types for implementation. Source of truth is this spec
until the code is written.

```typescript
// src/abip/types.ts

export type MessageType =
  | "TEXT" | "VOICE" | "IMAGE" | "COMMAND" | "SYSTEM" | "TYPING" | "STATUS" | "FILE";

export type SystemEvent =
  | "REGISTER" | "REGISTER_ACK" | "JOIN" | "JOIN_ACK" | "PART" | "PART_ACK"
  | "PING" | "PONG" | "ERROR" | "SHUTDOWN" | "OUTBOX_DRAIN" | "PLUGIN_OFFLINE";

export interface AbipMessage {
  abip: "0.1";
  id: string;          // UUID
  ts: number;          // Unix ms
  src: string;         // sender address
  dst: string;         // destination address or channel
  type: MessageType;
  payload: AbipPayload;
}

export interface TextPayload { content: string }
export interface VoicePayload { audioBase64: string; transcript: string; durationMs?: number }
export interface ImagePayload { imageBase64: string; mimeType: string; caption?: string }
export interface TypingPayload { active: boolean }
export interface StatusPayload { subject: string; state: "idle"|"busy"|"error"|"disconnected"; summary?: string }
export interface CommandPayload { command: string; args: Record<string, unknown> }
export interface SystemPayload { event: SystemEvent; [key: string]: unknown }

export type AbipPayload =
  | TextPayload | VoicePayload | ImagePayload | TypingPayload
  | StatusPayload | CommandPayload | SystemPayload;

export type PluginType = "transport" | "terminal" | "mobile" | "bridge" | "mcp";

export interface PluginSpec {
  id: string;
  type: PluginType;
  name: string;
  version?: string;
  capabilities: MessageType[];
  channels: string[];
  commands?: CommandSpec[];
}

export interface CommandSpec {
  name: string;
  description: string;
  args: string;
  subcommands?: CommandSpec[];
}

export interface ChannelMembership {
  channel: string;
  members: string[];      // plugin addresses
  lastMessageId?: string;
  lastMessageTs?: number;
  outbox: AbipMessage[];  // buffered for offline members, max 50
}
```

---

## Appendix: Design Decisions

### JSON not text (IRC sends text)

IRC's text protocol is debuggable but fragile for structured payloads (escaping,
multi-line messages, binary data). We keep JSON because the codebase already
uses it everywhere and binary payloads (audio, images) need base64 encoding
regardless. The addressing discipline (src/dst on every message) is what we
take from IRC, not the wire format.

### UDS for local plugins, WebSocket for remote

Unix Domain Sockets are faster and more secure for same-machine communication.
WebSocket is the right choice for mobile clients and remote hubs because it
works through NAT, supports TLS, and is the existing PAILot gateway protocol.

### Channel-per-session vs single multiplexed channel

Each Claude Code session is its own channel. This matches IRC's mental model
and solves the current `activeClientId` / `messageSource` mess: instead of
global mutable state tracking which session is "active," plugins simply JOIN
the session channel they want to talk to. Multiple listeners (PAILot, MCP
process, another session) can all JOIN the same session channel simultaneously.

### Pre-shared token for mesh auth

Certificate exchange (mTLS) is the right long-term answer for multi-user or
internet-exposed deployments. For v0.1, a pre-shared token in `~/.aibroker/env`
is sufficient for single-user LAN mesh. The REGISTER handshake already has an
`auth` field; swapping token for cert in a future version is additive.

### Outbox at hub layer, not gateway layer

The current outbox lives in `gateway.ts` (PAILot-specific). Moving it to the
hub's channel layer means any plugin — WhatsApp, Telegram, a CLI tool — gets
automatic buffering for free. It also means mesh-linked hubs can buffer
cross-hub messages during link interruptions.
