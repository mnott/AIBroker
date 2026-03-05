# AIBroker Adapter Onboarding — AI-Guided Creation

You are helping a developer create a new AIBroker messaging adapter. Your job is to ask up to 5 targeted questions, then generate a complete, working adapter from the scaffold templates.

Work through the following phases in order.

---

## Phase 1: Interview (5 questions max)

Ask only what you need. If the answer is obvious from context (e.g. the user says "Discord"), skip the question. Combine questions where sensible. Never ask more than 5.

**The 5 questions:**

1. **Service name** — What service are you connecting? (e.g. Signal, Discord, Slack, IRC, Matrix)
2. **Package name** — What npm package should be used? (If you don't know, say "search for me" — you will search npm.)
3. **Auth method** — How does the SDK authenticate? (QR code scan, phone number + OTP, API key, OAuth, bot token, username/password)
4. **Message model** — Does the service have the concept of channels/rooms/groups, or is it always a 1:1 direct chat? Who is the default recipient?
5. **Voice support** — Does the service support sending voice/audio messages? If yes, what format does it accept? (Most accept OGG Opus or MP3.)

If the user already answered any of these in their initial message, skip those questions.

---

## Phase 2: npm Research

Before generating code, search npm for the best library for this service:

```bash
# Search npm for available packages
npm search <service-name> --json | head -20

# Read the top candidate's README
npm show <package-name> readme
```

Pick the most maintained package (high weekly downloads, recent publish date, active repo). If the user specified a package, verify it exists and read its docs anyway.

Read the package README for:
- Connection/auth pattern (how to establish a session)
- How to receive incoming messages (event name, callback signature)
- How to send a text message (method name, arguments)
- How to send a file/audio (if applicable)
- Session persistence (does it save credentials to disk?)

---

## Phase 3: Generate the Adapter

Generate all files listed below. Use the scaffold templates in `templates/adapter/` as the starting point and replace all `{{ADAPTER_NAME}}` and `{{DISPLAY_NAME}}` placeholders.

**Variable substitution:**
- `{{ADAPTER_NAME}}` — lowercase hyphenated package name (e.g. `signal-bridge`, `discord-adapter`)
- `{{DISPLAY_NAME}}` — human-readable service name (e.g. `Signal`, `Discord`)

### Files to generate

**`package.json`** — from `templates/adapter/package.json.tmpl`
- Fill in name, description
- Add the chosen npm library to `dependencies`

**`tsconfig.json`** — from `templates/adapter/tsconfig.json.tmpl`
- No changes needed

**`src/watcher/state.ts`** — from `templates/adapter/src/watcher/state.ts.tmpl`
- Replace placeholders only
- The socket path must be `/tmp/{{ADAPTER_NAME}}-watcher.sock`

**`src/watcher/connection.ts`** — from `templates/adapter/src/watcher/connection.ts.tmpl`
- THIS IS THE CORE IMPLEMENTATION FILE — replace the stub with real SDK code
- Implement `connectWatcher()` using the library you researched
- The function must:
  1. Load credentials from `appDir` (use `getAppDir()` from aibroker if available, or `os.homedir()` + `.{{ADAPTER_NAME}}/auth/`)
  2. Establish connection to the service
  3. Subscribe to incoming messages, calling `onMessage(text, timestamp)` for each
  4. Return `cleanup()` to disconnect gracefully
  5. Return `triggerLogin()` to start a fresh auth flow (QR, OTP, etc.)
- Include all necessary imports from the chosen npm package
- Handle reconnection if the SDK supports it
- Log connection events with `log()` from aibroker

**`src/watcher/send.ts`** — from `templates/adapter/src/watcher/send.ts.tmpl`
- Replace stubs with real SDK delivery calls
- `sendText(text, recipient?)` — send plain text
- `sendVoice(audioPath, recipient?)` — send OGG Opus audio file (skip with a clear comment if service does not support voice)
- `sendFile(filePath, caption?, mimetype?, recipient?)` — send document attachment

**`src/watcher/commands.ts`** — from `templates/adapter/src/watcher/commands.ts.tmpl`
- Replace placeholders only
- This is a thin handler — only /restart and /login are local
- All other commands are forwarded to the hub by index.ts

**`src/watcher/ipc-server.ts`** — from `templates/adapter/src/watcher/ipc-server.ts.tmpl`
- Replace placeholders only
- The required IPC handlers are already present: `deliver`, `health`, `connection_status`, `login`

**`src/watcher/index.ts`** — from `templates/adapter/src/watcher/index.ts.tmpl`
- Replace placeholders only
- The hub-required pattern (connectToHub with retry, heartbeat, re-registration) is built in

**`src/watcher/cli.ts`** — from `templates/adapter/src/watcher/cli.ts.tmpl`
- Replace placeholders only

**`src/index.ts`** — MCP server entry point
- Model this on Whazaa's `src/index.ts` (the reference implementation)
- Expose MCP tools named `<service>_send`, `<service>_status`, `<service>_tts` (voice, if supported), `<service>_send_file`
- Wire each tool to the corresponding IPC handler via `WatcherClient`
- Socket path: `/tmp/{{ADAPTER_NAME}}-watcher.sock`

**`README.md`** — from `templates/adapter/README.md.tmpl`
- Fill in service name, auth instructions, and any service-specific setup steps

---

## Phase 4: Wire into AIBroker Config

After generating the adapter files, register the adapter with the AIBroker hub:

1. **Check if `~/.aibroker/config.json` exists.** If yes, add an entry to the `adapters` array:
```json
{
  "name": "{{ADAPTER_NAME}}",
  "socketPath": "/tmp/{{ADAPTER_NAME}}-watcher.sock",
  "autoStart": false
}
```

2. **Register as an MCP server** in `~/.claude.json` under `mcpServers`:
```json
"{{ADAPTER_NAME}}": {
  "type": "stdio",
  "command": "node",
  "args": ["/path/to/{{ADAPTER_NAME}}/dist/index.js"],
  "description": "{{DISPLAY_NAME}} MCP adapter"
}
```

3. **Add permission** in `~/.claude/settings.json` under `permissions.allow`:
```json
"mcp__{{ADAPTER_NAME}}"
```

---

## Phase 5: Test the Connection

After generating all files:

```bash
# Ensure the AIBroker hub is running
aibroker start

# Build and start the adapter
cd /path/to/{{ADAPTER_NAME}}
npm install
npm run build
node dist/watcher/cli.js watch
```

The adapter will:
1. Connect to the AIBroker hub (fails if hub is not running)
2. Connect to the upstream service
3. Register with the hub
4. Start its IPC server

Verify the IPC server is responding:
```bash
node -e "
import { WatcherClient } from 'aibroker';
const c = new WatcherClient('/tmp/{{ADAPTER_NAME}}-watcher.sock');
c.call_raw('health', {}).then(r => console.log(JSON.stringify(r, null, 2)));
"
```

Expected health response:
```json
{
  "ok": true,
  "result": {
    "status": "ok",
    "connectionStatus": "connected",
    "stats": { "messagesReceived": 0, "messagesSent": 0, "errors": 0 },
    "lastMessageAgo": null
  }
}
```

If `status` is `"down"` or `connectionStatus` is not `"connected"`, check the watcher logs for auth/connection errors and run `triggerLogin()` via the `login` IPC handler.

---

## Interface Contracts (Reference)

### MessengerAdapter interface

Every adapter fulfills this interface structurally via IPC handlers:

```typescript
interface MessengerAdapter {
  // Lifecycle
  start(config: AdapterConfig): Promise<void>;
  stop(): Promise<void>;
  health(): Promise<AdapterHealth>;       // IPC: "health"

  // Auth
  login(): Promise<string>;               // IPC: "login"
  connectionStatus(): Promise<AdapterConnectionStatus>; // IPC: "connection_status"

  // Outbound
  sendText(text, recipient?): Promise<void>;                          // IPC: "send"
  sendVoice(audioPath, recipient?): Promise<void>;                    // IPC: "send_voice"
  sendFile(filePath, caption?, mimetype?, recipient?): Promise<void>; // IPC: "send_file"
  sendImage(imagePath, caption?, recipient?): Promise<void>;          // IPC: "send_image"
}
```

### AdapterHealth contract

```typescript
interface AdapterHealth {
  status: "ok" | "degraded" | "down";
  connectionStatus: "connected" | "connecting" | "disconnected" | "error";
  stats: {
    messagesReceived: number;
    messagesSent: number;
    errors: number;
  };
  lastMessageAgo: number | null;
  detail?: string;
}
```

### BrokerMessage (hub envelope)

```typescript
interface BrokerMessage {
  id: string;          // UUID
  timestamp: number;   // epoch ms
  source: string;      // adapter name that sent it
  target?: string;     // target adapter name (omit for default routing)
  type: "text" | "voice" | "file" | "image" | "command" | "status";
  payload: {
    text?: string;
    filePath?: string;
    audioPath?: string;
    buffer?: string;     // base64-encoded binary data (images, voice)
    mimetype?: string;
    caption?: string;
    recipient?: string;
    channel?: string;
    metadata?: Record<string, unknown>;
  };
}
```

### Required IPC handlers

| Handler | Called by | Must return |
|---------|-----------|-------------|
| `deliver` | Hub, when routing a BrokerMessage to this adapter | `{ ok: true, result: { delivered: true } }` or `{ ok: false, error: string }` |
| `health` | Hub health polling (every 10s) | `{ ok: true, result: AdapterHealth }` |
| `connection_status` | Hub, MCP tools | `{ ok: true, result: { status: AdapterConnectionStatus } }` |
| `login` | User, via MCP tool | `{ ok: true, result: { message: string } }` |
| `send` | MCP tool | `{ ok: true, result: { sent: true } }` |
| `send_voice` | MCP tool | `{ ok: true, result: { sent: true } }` |
| `send_file` | MCP tool | `{ ok: true, result: { sent: true } }` |
| `status` | MCP tool | Human-readable status object |

### Hub-required architecture

The adapter **requires** the AIBroker hub daemon to be running:

```
Adapter startup:
  1. connectToHub() — probe hub via "ping", retry 3x, fail if unreachable
  2. connectWatcher() — establish upstream service connection
  3. startIpcServer() — start adapter IPC server on its socket
  4. register_adapter — announce to hub so it can push outbound messages
  5. heartbeat loop — ping hub every 30s, re-register if it restarts
```

Adapters do NOT:
- Create their own APIBackend or HybridSessionManager
- Handle commands locally (except /restart and /login)
- Run TTS, STT, screenshots, or image generation
- Manage sessions

---

## Reference Implementation

**Whazaa** is the canonical reference adapter. When in doubt, model behaviour on Whazaa:

- Repo: `~/dev/ai/Whazaa/`
- Key file — connection: `src/watcher/baileys.ts` (WhatsApp-specific connection)
- Key file — send: `src/watcher/send.ts`
- Key file — IPC: `src/watcher/ipc-server.ts`
- Key file — MCP tools: `src/index.ts`
- Key file — watcher: `src/watcher/index.ts` (thin hub-required adapter pattern)
- Key pattern — Baileys saves auth state to `~/.whazaa/auth/` via `useMultiFileAuthState()`

The Whazaa pattern for `connectWatcher()` is:
1. Call `useMultiFileAuthState(authDir)` (or equivalent for your SDK)
2. Create the client instance with the auth state
3. Set up message event listener calling `onMessage(text, timestamp)`
4. Call `client.connect()` or equivalent
5. Return `cleanup` (calls `client.logout()` or `client.disconnect()`) and `triggerLogin` (generates new QR/pairing)

Follow this pattern exactly. The template scaffold maps cleanly onto it.
