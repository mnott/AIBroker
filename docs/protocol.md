# AIBP Protocol Specification

AIBP (AIBroker Interchange Protocol) version 0.1 is the internal message routing protocol used by the AIBroker hub. Every message that flows through the system — from a WhatsApp user to a Claude Code session, from a PAILot voice note to the TTS pipeline — is wrapped in an AIBP envelope.

## Wire Format

AIBP uses NDJSON (newline-delimited JSON). Each message is a single JSON object followed by a newline character (`\n`). This is the same format as the IPC layer.

```
{"aibp":"0.1","id":"...","ts":1234567890,"src":"...","dst":"...","type":"TEXT","payload":{...}}\n
```

## Message Envelope

Every AIBP message has this exact shape (`AibpMessage` in `src/aibp/types.ts`):

```typescript
interface AibpMessage {
  aibp: "0.1";          // Protocol version — always "0.1"
  id: string;           // UUID v4, unique per message
  ts: number;           // Unix timestamp in milliseconds
  src: string;          // Source address (see addressing below)
  dst: string;          // Destination address
  type: MessageType;    // One of eight message types
  payload: AibpPayload; // Type-specific payload object
}
```

### Field Semantics

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `aibp` | `"0.1"` | yes | Protocol version identifier |
| `id` | string | yes | UUID v4, assigned by the sender at creation |
| `ts` | number | yes | Milliseconds since Unix epoch |
| `src` | string | yes | Address of the originating plugin |
| `dst` | string | yes | Address of the destination (plugin, channel, or mesh) |
| `type` | string | yes | Message type (TEXT, VOICE, etc.) |
| `payload` | object | yes | Type-specific payload; never null |

## Message Types

Eight message types exist, corresponding to different payload schemas:

```typescript
type MessageType =
  | "TEXT"    // Plain text content
  | "VOICE"   // Audio with transcript
  | "IMAGE"   // Image with optional caption
  | "COMMAND" // Slash command dispatch
  | "SYSTEM"  // Protocol control events
  | "TYPING"  // Typing indicator (not buffered)
  | "STATUS"  // Session state signal
  | "FILE";   // File transfer
```

### TEXT

The most common type. Carries plain text content between plugins.

```typescript
interface TextPayload {
  content: string; // The message text
}
```

Example:
```json
{
  "aibp": "0.1",
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "ts": 1741420800000,
  "src": "mobile:pailot",
  "dst": "session:ABC123-DEF456",
  "type": "TEXT",
  "payload": { "content": "What's the status of the build?" }
}
```

### VOICE

Audio data with a transcript. The audio is base64-encoded OGG Opus (for network delivery) or M4A (for iOS playback). The transcript comes from Whisper STT.

```typescript
interface VoicePayload {
  audioBase64: string;            // Base64-encoded audio
  transcript: string;             // Whisper transcription
  transcriptConfidence?: number;  // Optional confidence score
  durationMs?: number;            // Recording duration
}
```

### IMAGE

Image data with optional caption. Used for screenshots, generated images, and user photo uploads.

```typescript
interface ImagePayload {
  imageBase64: string; // Base64-encoded image data
  mimeType: string;    // e.g., "image/png", "image/jpeg"
  caption?: string;    // Optional description
}
```

### COMMAND

Slash command dispatch. Used internally by the AIBP registry to route commands to the plugin that registered them.

```typescript
interface CommandPayload {
  command: string;               // Command name (without slash)
  args: Record<string, unknown>; // Command arguments
}
```

### SYSTEM

Protocol control messages. Used for plugin lifecycle events, heartbeats, and error reporting. The `event` field determines semantics.

```typescript
interface SystemPayload {
  event: SystemEvent;
  [key: string]: unknown; // Event-specific extra fields
}
```

System events and their extra fields are documented in the [System Events](#system-events) section below.

### TYPING

Transient indicator that a participant is composing a message. Not buffered in the outbox — if the recipient is offline, the indicator is silently dropped.

```typescript
interface TypingPayload {
  active: boolean; // true = typing started, false = stopped
}
```

### STATUS

Session state signal. Used to communicate the current state of a Claude Code session.

```typescript
interface StatusPayload {
  subject: string;                                     // Session ID or name
  state: "idle" | "busy" | "error" | "disconnected"; // Current state
  summary?: string;                                    // Optional text summary
}
```

### FILE

File transfer. Supports either inline data (dataBase64) or a file system path.

```typescript
interface FilePayload {
  filename: string;     // Original filename
  mimeType: string;     // MIME type
  dataBase64?: string;  // Inline data (optional)
  path?: string;        // File system path (optional)
  sizeBytes?: number;   // File size
}
```

## Address Format

Every plugin in the registry has an address derived from its type and ID:

```
type:id
```

Examples:
- `transport:whazaa` — Whazaa adapter (WhatsApp transport)
- `transport:telex` — Telex adapter (Telegram transport)
- `mobile:pailot` — PAILot mobile gateway
- `terminal:iterm` — iTerm2 terminal plugin
- `mcp:ABC123` — MCP server process
- `hub:local` — The hub itself (built-in commands)
- `hub:session-handler` — The hub's session dispatch plugin

### Address Type Prefixes

The prefix determines how the AIBP registry resolves the address:

| Prefix | Plugin type | Assigned by |
|--------|-------------|-------------|
| `transport:` | Transport adapter (WhatsApp, Telegram) | Registry from `spec.type` |
| `terminal:` | Terminal plugin (iTerm2) | Registry from `spec.type` |
| `mobile:` | Mobile gateway (PAILot) | Registry from `spec.type` |
| `bridge:` | Mesh bridge to remote hub | Registry from `spec.type` |
| `mcp:` | MCP server process | Registry from `spec.type` |
| `hub:` | Hub-internal plugin | Registry from `spec.type` |

### Session Channels

Session channels are a special address type used to route messages to a specific Claude Code session:

```
session:UUID
```

Where UUID is the iTerm2 session ID (a UUID v4 string). A session channel can have multiple members (the hub's session handler, the PAILot mobile plugin, an MCP process). When a message is sent to a channel, it is fanned out to all members.

If a plugin sends to `session:UUID` and no such channel exists, the registry auto-creates the channel and buffers the message in its outbox until a plugin joins.

### Mesh Addresses

For multi-machine routing, mesh addresses encode a remote hub and a local destination on that hub:

```
hub:name/type:id
```

Examples:
- `hub:mac-mini/session:DEF456` — session DEF456 on the hub named "mac-mini"
- `hub:work-laptop/mobile:pailot` — PAILot plugin on the "work-laptop" hub

The `/` separator is the key distinguisher. `isLocal()` returns false if the address contains `/`. `parseMeshAddress()` splits it into `{ hub: "hub:mac-mini", local: "session:DEF456" }`.

## System Events

System events drive the plugin lifecycle and heartbeat mechanism. All system events are carried in `SYSTEM` messages.

### Registration

**REGISTER** (plugin → hub): Not sent as a message in the current implementation. Registration is done by calling `registry.register(spec, sendFn)` directly. The equivalent message is the `aibp_register` IPC call.

**REGISTER_ACK** (hub → plugin): Sent by the registry after successful registration.

```json
{
  "event": "REGISTER_ACK",
  "assignedAddress": "mcp:ABC123",
  "hubVersion": "0.1",
  "peers": ["transport:whazaa", "mobile:pailot", "terminal:iterm"]
}
```

**ERROR** (hub → plugin): Sent when registration is rejected (e.g., duplicate address).

```json
{
  "event": "ERROR",
  "code": "REGISTER_REJECTED",
  "reason": "Plugin address transport:whazaa already registered"
}
```

### Channel Events

**JOIN** (plugin → hub): Plugin requests to join a channel. Handled by `registry.join()`. Returns `JOIN_ACK`.

**JOIN_ACK** (hub → plugin): Confirms channel join.

```json
{
  "event": "JOIN_ACK",
  "channel": "session:ABC123",
  "members": ["hub:session-handler", "mobile:pailot"],
  "unreadCount": 3
}
```

The `unreadCount` indicates how many messages were buffered in the channel outbox while the plugin was absent. These are drained immediately after JOIN_ACK.

**PART** (plugin → hub): Plugin leaves a channel. Returns `PART_ACK`.

**PART_ACK** (hub → plugin): Confirms channel part.

```json
{
  "event": "PART_ACK",
  "channel": "session:ABC123",
  "reason": "left"
}
```

### Heartbeat

**PING** (plugin → hub): Lightweight liveness signal. Sent every 30 seconds by adapters.

```json
{ "event": "PING" }
```

**PONG** (hub → plugin): Acknowledgment. The hub also resets the plugin's `missedPings` counter and sets `status: "active"`.

```json
{ "event": "PONG" }
```

### Disconnection

**PLUGIN_OFFLINE** (hub → all): Broadcast to all remaining plugins when a plugin disconnects or is evicted for missing heartbeats.

```json
{
  "event": "PLUGIN_OFFLINE",
  "plugin": "transport:whazaa",
  "reason": "heartbeat timeout"
}
```

**OUTBOX_DRAIN** (hub → plugin): Sent before delivering buffered messages when a plugin joins a channel that has queued messages.

```json
{
  "event": "OUTBOX_DRAIN",
  "channel": "session:ABC123",
  "count": 5,
  "summary": "5 messages while offline"
}
```

**SHUTDOWN** (hub → all): Sent before graceful hub shutdown. Not currently implemented in the daemon shutdown path.

## Routing Algorithm

See [routing.md](./routing.md) for the full routing algorithm. In brief:

1. If `dst` contains `/` (mesh address) → forward to bridge plugin
2. If `dst === "hub:local"` → dispatch to hub built-in handler
3. If `dst` matches a registered plugin address → deliver directly
4. If `dst` matches a channel → fan-out to all members except sender
5. If `dst` starts with `session:` and no channel exists → auto-create and buffer
6. Otherwise → log routing failure

## Message Factory Functions

`src/aibp/envelope.ts` provides factory functions for creating correctly-formed messages:

```typescript
// Create a text message
const msg = text("mobile:pailot", "session:ABC123", "Hello");

// Create a voice message
const msg = voice("mobile:pailot", "session:ABC123", audioB64, transcript, durationMs);

// Create an image message
const msg = image("session:ABC123", "mobile:pailot", imageB64, "image/png", "Screenshot");

// Create a typing indicator
const msg = typing("mobile:pailot", "session:ABC123", true);

// Create a system event
const msg = system("hub:local", "transport:whazaa", "REGISTER_ACK", { assignedAddress: "...", peers: [] });

// Create a command message
const msg = command("mobile:pailot", "hub:local", "list_channels", {});
```

All factory functions automatically assign `id` (UUID v4) and `ts` (current timestamp).

## Parsing and Validation

`parse(raw: string): AibpMessage | null` — Parses an NDJSON line. Returns null if JSON is invalid or the object does not satisfy `isAibpMessage()`.

`isAibpMessage(obj): obj is AibpMessage` — Type guard that checks all required fields are present and correctly typed. Does not validate payload contents.

`serialize(msg: AibpMessage): string` — Serializes to NDJSON (JSON string + newline).

## Built-in Hub Commands

When a message is sent to `dst: "hub:local"` with `type: "COMMAND"`, the registry handles built-in commands:

| Command | Description | Response |
|---------|-------------|----------|
| `list_channels` | List all channels with member counts and outbox sizes | REGISTER_ACK with `channels` array |
| `list_plugins` | List all registered plugins with type, name, status | REGISTER_ACK with `plugins` array |

Unknown hub commands return an `ERROR` system event with `code: "UNKNOWN_COMMAND"`.

## Protocol Version

The current version is `0.1`. The `aibp` field in every message header is a literal string `"0.1"`. Version negotiation is not implemented; all plugins must use the same version.
