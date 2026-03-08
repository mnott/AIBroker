# Adapters

Adapters are the transport layer of AIBroker. Each adapter owns exactly one thing: a network connection to a messaging platform. Everything else — commands, session management, TTS, routing — belongs to the hub.

## What Adapters Own

**Adapters own only:**
1. The upstream network connection (WhatsApp socket, Telegram long-poll, Discord WebSocket, etc.)
2. Forwarding inbound messages to the hub via IPC
3. Receiving outbound messages from the hub and delivering them upstream

**Adapters do NOT own:**
- Slash command handling
- Session management
- TTS or STT
- Image generation
- MCP servers (stripped in v0.6)
- Routing logic

This is a hard architectural constraint enforced by the `CLAUDE.md` rule: _Adapters require the hub and cannot function without it._

## Current Adapters

| Adapter | Platform | IPC Socket |
|---------|----------|------------|
| Whazaa | WhatsApp (via Baileys) | `/tmp/whazaa-watcher.sock` |
| Telex | Telegram (via gramjs) | `/tmp/telex-watcher.sock` |

Both are separate npm packages (`whazaa`, `telex`). Neither is part of the AIBroker repository.

## Adapter Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Adapter Process                   │
│                                                      │
│  ┌──────────────┐    ┌───────────────────────────┐  │
│  │  Upstream    │    │  IPC Server               │  │
│  │  Connection  │    │  /tmp/{name}-watcher.sock │  │
│  │  (WA/TG SDK) │    │                           │  │
│  └──────┬───────┘    │  Required handlers:       │  │
│         │            │    deliver                 │  │
│         │ inbound    │    health                  │  │
│         ▼            │    connection_status       │  │
│  ┌──────────────┐    │                           │  │
│  │  onMessage() │    │  Optional handlers:       │  │
│  │  callback    │    │    send, send_voice        │  │
│  └──────┬───────┘    │    send_file, login        │  │
│         │            └─────────────┬─────────────┘  │
│         │ IPC call                 │ inbound calls   │
└─────────┼──────────────────────────┼────────────────┘
          │                          │
          │                    ┌─────▼──────────────────┐
          │ register_adapter   │    AIBroker Hub         │
          └───────────────────►│    /tmp/aibroker.sock   │
                               └────────────────────────┘
```

## IPC Protocol: Adapter ↔ Hub

Both sides communicate over Unix Domain Sockets using NDJSON. All calls follow the same envelope format described in [ipc.md](./ipc.md).

### Adapter → Hub (Outbound to hub)

When an adapter starts, it calls `register_adapter` on the hub socket:

```json
{
  "method": "register_adapter",
  "params": {
    "name": "whazaa",
    "socketPath": "/tmp/whazaa-watcher.sock"
  }
}
```

When an inbound message arrives from the upstream platform, the adapter calls `command` on the hub:

```json
{
  "method": "command",
  "params": {
    "text": "/ss",
    "timestamp": 1741420800000,
    "sessionId": "...",
    "source": "whazaa",
    "recipient": "+41791234567"
  }
}
```

The hub processes the command and replies back via the adapter's `deliver` handler.

### Hub → Adapter (Inbound to adapter)

The hub calls the adapter's `deliver` handler to push outbound content:

```json
{
  "method": "deliver",
  "params": {
    "message": {
      "type": "text",
      "source": "hub",
      "payload": {
        "text": "Screenshot taken.",
        "recipient": "+41791234567"
      }
    }
  }
}
```

Supported `message.type` values:

| Type | Payload fields | Delivery |
|------|---------------|----------|
| `text` | `text`, `recipient?` | Send text message |
| `voice` | `buffer` (base64 OGG) or `audioPath`, `recipient?` | Send voice note |
| `image` | `buffer` (base64), `text?` (caption), `recipient?` | Send image |
| `file` | `filePath`, `caption?`, `mimetype?`, `recipient?` | Send file attachment |
| `command` | `text`, `recipient?` | Deliver as text (fallback) |

## Required IPC Handlers

Every adapter MUST implement these three handlers on its IPC server:

### `deliver`

Called by the hub to push outbound content to the upstream platform. This is the hub→adapter channel.

```typescript
server.on("deliver", async (req) => {
  const { message } = req.params as { message: BrokerMessage };
  // Route based on message.type
  switch (message.type) {
    case "text": await sendText(payload.text, recipient); break;
    case "voice": await sendVoice(voicePath, recipient); break;
    // ...
  }
  return { ok: true, result: { delivered: true } };
});
```

### `health`

Called by the hub's health poller every 60 seconds. Returns an `AdapterHealth`-compatible object:

```typescript
server.on("health", async (_req) => {
  return {
    ok: true,
    result: {
      status: "ok" | "degraded" | "down",
      connectionStatus: "connected" | "connecting" | "disconnected" | "error",
      stats: { messagesReceived: N, messagesSent: N, errors: N },
      lastMessageAgo: milliseconds | null,
      detail?: "optional error message",
    },
  };
});
```

### `connection_status`

Returns the current upstream connection state as a string.

```typescript
server.on("connection_status", async (_req) => {
  return { ok: true, result: { status: connectionStatus } };
});
```

## Optional IPC Handlers

Adapters may implement these handlers, which are called by MCP tools via the `adapter_call` hub proxy:

| Handler | Parameters | Description |
|---------|-----------|-------------|
| `send` | `message`, `recipient?` | Send text directly to the platform |
| `send_voice` | `audioPath`, `recipient?` | Send a voice note from a file path |
| `send_file` | `filePath`, `caption?`, `mimetype?`, `recipient?` | Send a file attachment |
| `login` | — | Trigger a fresh login / QR pairing flow |
| `status` | — | Human-readable status summary string |

MCP tools call these via `adapter_call`:

```typescript
// MCP: whatsapp_send
hub.call_raw("adapter_call", {
  adapter: "whazaa",
  method: "send",
  params: { message: "Hello", recipient: "+41791234567" }
});
```

## Health Monitoring

The hub's `AdapterRegistry` polls all registered adapters every 60 seconds with a 5-second timeout:

```
Hub                            Adapter
  │                                │
  │── health (5s timeout) ────────►│
  │◄─ { status, connectionStatus, stats } ─│
```

Health states:

| `status` | Meaning |
|----------|---------|
| `"ok"` | Upstream connected, adapter responding |
| `"degraded"` | Adapter responding but upstream issues |
| `"down"` | Adapter not responding or upstream disconnected |

Health changes are logged on status change only (not every 60s poll). The current health is exposed via the `aibroker_status` MCP tool.

## Adapter Registration

Adapters register themselves with the hub at startup, and unregister on clean shutdown:

```
Adapter starts
    │
    ├─ Connect to upstream (WhatsApp, Telegram, etc.)
    ├─ Start IPC server on /tmp/{name}-watcher.sock
    └─ Call hub: register_adapter { name, socketPath }
           │
           └─ Hub: AdapterRegistry.register(descriptor)
                   Start health polling

Adapter shuts down
    │
    └─ Call hub: unregister_adapter { name }
           │
           └─ Hub: AdapterRegistry.unregister(name)
```

The hub auto-discovers adapters at startup by checking known socket paths:

```typescript
const KNOWN_ADAPTERS = [
  { name: "whazaa", socketPath: "/tmp/whazaa-watcher.sock" },
  { name: "telex",  socketPath: "/tmp/telex-watcher.sock" },
];
```

If the socket exists and responds to a `health` call within 3 seconds, the adapter is auto-registered.

## How Inbound Messages Flow

```
User sends WhatsApp message
        │
        ▼
Baileys (WhatsApp SDK) → Whazaa onMessage() callback
        │
        ▼ IPC call
Hub: command handler
        │
        ▼
createHubCommandHandler()
        │
  ┌─────┴─────────────────────────────────┐
  │                                       │
  ▼                                       ▼
slash command                      plain text
(handled by hub)                   (delivered to iTerm2 / API session)
  │
  ▼
reply via ctx.reply()
  │
  ▼ IPC: deliver
Adapter → sendText() → WhatsApp API
        │
        ▼
User receives reply
```

The `CommandContext.reply()` callback is wired at dispatch time to call back into the originating adapter's `deliver` handler. The command handler itself never calls WhatsApp or Telegram directly.

## Writing a New Adapter

Use the scaffold in `templates/adapter/`. The template uses `{{ADAPTER_NAME}}` and `{{DISPLAY_NAME}}` placeholders.

### Files

```
src/
├── watcher/
│   ├── index.ts         — Entry point: wire connection + IPC server + hub registration
│   ├── connection.ts    — Upstream connection (implement this for your platform)
│   ├── ipc-server.ts    — IPC server with all required handlers
│   ├── send.ts          — sendText(), sendVoice(), sendFile() for your platform
│   ├── state.ts         — Shared state: connectionStatus, adapterStats, SOCKET_PATH
│   ├── commands.ts      — Any adapter-local command handling (optional)
│   └── cli.ts           — CLI: start, stop, status, restart
```

### Step 1: Implement `connection.ts`

```typescript
export async function connectWatcher(
  onMessage: (text: string, timestamp: number) => void,
): Promise<ConnectionResult> {
  // 1. Load credentials (use getAppDir() from aibroker)
  // 2. Connect to your platform's SDK/API
  // 3. Subscribe to messages, call onMessage() for each
  // 4. Return cleanup() and triggerLogin()
}
```

### Step 2: Implement `send.ts`

```typescript
export async function sendText(text: string, recipient?: string): Promise<void> {
  // Send text to your platform
}

export async function sendVoice(audioPath: string, recipient?: string): Promise<void> {
  // Send OGG Opus voice note
}

export async function sendFile(
  filePath: string, caption?: string, mimetype?: string, recipient?: string
): Promise<void> {
  // Send file attachment
}
```

### Step 3: Wire in `index.ts`

```typescript
// Start IPC server
const ipcServer = startIpcServer(connection.triggerLogin);

// Register with hub
const hubClient = new WatcherClient(HUB_SOCKET_PATH);
await hubClient.call_raw("register_adapter", {
  name: ADAPTER_NAME,
  socketPath: ADAPTER_SOCKET_PATH,
});
```

### Step 4: Forward Inbound Messages

In `connectWatcher()`:

```typescript
onMessage: (text, timestamp) => {
  const hubClient = new WatcherClient(HUB_SOCKET_PATH);
  await hubClient.call_raw("command", {
    text,
    timestamp,
    source: ADAPTER_NAME,
    recipient: senderJid, // platform-specific sender ID
  });
}
```

### Platform-Specific Notes

**NEVER import into AIBroker** (this breaks the hard rule):
- `@whiskeysockets/baileys` — stays in Whazaa
- `gramjs` — stays in Telex
- `better-sqlite3` — stays in adapters that need it
- `qrcode` — stays in adapters that need QR display

These libraries stay in their respective adapter packages. AIBroker only exports platform-agnostic utilities.

## The `adapter_call` IPC Proxy

MCP tools that need adapter-specific capabilities (like listing WhatsApp chats) go through the hub's `adapter_call` IPC handler rather than calling the adapter directly. This keeps the MCP server decoupled from adapter socket paths:

```
Claude Code ──► MCP: whatsapp_chats
                     │
                     ▼
            Hub: adapter_call { adapter: "whazaa", method: "chats", params: {} }
                     │
                     ▼
            WatcherClient → /tmp/whazaa-watcher.sock
                     │
                     ▼
            Whazaa: chats handler → return list
                     │
                     ▼
            Hub: forward result back to MCP
                     │
                     ▼
Claude Code ◄── chats list
```

See [mcp-tools.md](./mcp-tools.md) for the complete list of MCP tools and which ones use `adapter_call`.
