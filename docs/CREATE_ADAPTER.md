# Creating an AIBroker Adapter

This guide explains how to build a new messaging adapter that plugs into the AIBroker hub. You can use the AI-assisted path (recommended, takes about an hour) or build manually.

---

## What Is an Adapter?

An adapter is an independent Node.js process that:

1. Connects to a messaging service (Signal, Discord, Slack, Matrix, IRC, etc.)
2. Receives incoming messages and forwards them to the AIBroker hub (or handles them locally)
3. Exposes an IPC server on a Unix Domain Socket so the hub and MCP tools can push outbound messages back
4. Optionally exposes MCP tools (`<service>_send`, `<service>_status`, `<service>_tts`, etc.) for use in Claude Code

Each adapter is a standalone npm package that imports shared infrastructure from `aibroker`.

---

## The Quick Way: AI-Guided Creation

### Step 1: Scaffold the project

```bash
aibroker create-adapter my-adapter
```

This creates a new directory `my-adapter/` with a filled-in scaffold from `templates/adapter/`. The stubs are ready to run but do nothing yet.

### Step 2: Open Claude Code and paste the onboarding prompt

Open Claude Code in the new adapter directory:

```bash
cd my-adapter
claude
```

Then paste the contents of `templates/adapter/ONBOARDING_PROMPT.md` as your first message. The prompt instructs Claude Code to:

- Ask 5 targeted questions about your service
- Search npm for the best library
- Read the library docs
- Generate a complete, working adapter by filling in `connection.ts` and `send.ts`
- Wire the adapter into the AIBroker hub config
- Run a connection test

### Step 3: Answer the 5 questions

Claude Code will ask up to 5 questions. Typical interview:

1. **Service name** — e.g. "Signal"
2. **npm package** — e.g. "signal-cli-rest-api" or "search for me"
3. **Auth method** — e.g. "phone number + OTP" or "QR code scan"
4. **Message model** — e.g. "1:1 chat, default recipient is my own number" or "channels with #room-name"
5. **Voice support** — e.g. "yes, OGG Opus" or "no"

If you already know the answers, include them in your initial message and Claude Code will skip those questions.

### Step 4: Review and test

Claude Code will generate the files, build the project, start the watcher, and run a health check. Review `src/watcher/connection.ts` and `src/watcher/send.ts` — these are the two files that contain service-specific code. Everything else is boilerplate that should not need changes.

---

## The Manual Way: Build It Yourself

If you prefer to implement the adapter by hand, follow these steps.

### Step 1: Scaffold

```bash
aibroker create-adapter my-adapter
cd my-adapter
```

This creates the full directory structure from `templates/adapter/`. Every file with a `.tmpl` extension has been processed — `{{ADAPTER_NAME}}` and `{{DISPLAY_NAME}}` are already replaced.

### Step 2: Install your service's npm package

```bash
npm install <service-sdk>
npm install
```

Add the package to the `dependencies` in `package.json`.

### Step 3: Implement `src/watcher/connection.ts`

This is the adapter-specific connection file. Replace the stub with real SDK code.

The function signature is:

```typescript
export async function connectWatcher(
  onMessage: (text: string, timestamp: number) => void,
): Promise<ConnectionResult>
```

Your implementation must:

1. Load credentials from `~/.my-adapter/auth/` (or wherever your SDK stores auth state)
2. Connect to the upstream service
3. Call `onMessage(text, Date.now())` for every incoming message your adapter should process
4. Return `cleanup()` — called on SIGTERM to disconnect gracefully
5. Return `triggerLogin()` — called when the user runs a login command; should start a QR/OTP flow and return a status string

```typescript
// Example skeleton
import { SomeSDK } from 'some-sdk';
import { log } from 'aibroker';
import { join } from 'node:path';
import { homedir } from 'node:os';

export async function connectWatcher(
  onMessage: (text: string, timestamp: number) => void,
): Promise<ConnectionResult> {
  const authDir = join(homedir(), '.my-adapter', 'auth');
  const client = new SomeSDK({ authDir });

  client.on('message', (msg) => {
    onMessage(msg.body, msg.timestamp ?? Date.now());
  });

  await client.connect();
  log('[my-adapter] connected');

  return {
    cleanup: () => client.disconnect(),
    triggerLogin: async () => {
      const qr = await client.generateQR();
      return `Scan this QR code: ${qr}`;
    },
  };
}
```

### Step 4: Implement `src/watcher/send.ts`

Fill in the three send functions:

```typescript
export async function sendText(text: string, recipient?: string): Promise<void> {
  await client.sendMessage(recipient ?? DEFAULT_RECIPIENT, text);
  adapterStats.messagesSent++;
}

export async function sendVoice(audioPath: string, recipient?: string): Promise<void> {
  await client.sendAudio(recipient ?? DEFAULT_RECIPIENT, { path: audioPath });
  adapterStats.messagesSent++;
}

export async function sendFile(
  filePath: string,
  caption?: string,
  mimetype?: string,
  recipient?: string,
): Promise<void> {
  await client.sendDocument(recipient ?? DEFAULT_RECIPIENT, { path: filePath, caption, mimetype });
  adapterStats.messagesSent++;
}
```

If the service does not support voice, throw an error or no-op with a comment — the IPC handler already returns `{ ok: false, error: ... }` if you throw.

### Step 5: Leave everything else as-is

The remaining files — `state.ts`, `commands.ts`, `ipc-server.ts`, `index.ts` (watcher entry), `cli.ts` — are complete from the scaffold. You only need to touch them if you want to add service-specific slash commands or extra IPC handlers.

### Step 6: Build and test

```bash
npm run build
node dist/watcher/cli.js watch
```

In a second terminal:

```bash
node -e "
const { WatcherClient } = await import('./node_modules/aibroker/dist/index.js');
const c = new WatcherClient('/tmp/my-adapter-watcher.sock');
const r = await c.call_raw('health', {});
console.log(JSON.stringify(r, null, 2));
"
```

---

## The 5 Interview Questions

When using the AI-guided path, Claude Code asks at most 5 questions before generating the adapter. Here is what each covers and why it matters:

| # | Question | Why it matters |
|---|----------|----------------|
| 1 | **Service name** | Sets `{{ADAPTER_NAME}}` and `{{DISPLAY_NAME}}` everywhere — package name, socket path, log prefix, MCP tool names |
| 2 | **npm package** | Claude Code searches npm, reads the README, and learns the exact API before writing `connection.ts` |
| 3 | **Auth method** | Determines what `triggerLogin()` does — generate a QR code, prompt for a phone number + OTP, exchange an API key, etc. |
| 4 | **Message model** | Sets the default recipient in `sendText()`. For multi-room services, adds a `/channel` command to `commands.ts` |
| 5 | **Voice support** | If yes, `sendVoice()` gets a real implementation. If no, it throws a `"voice not supported"` error |

---

## Generated Files and What Each Does

After `aibroker create-adapter my-adapter` (and AI generation), you get:

```
my-adapter/
├── package.json                    npm package descriptor + build scripts
├── tsconfig.json                   TypeScript compiler config
├── README.md                       User-facing setup and usage docs
└── src/
    ├── index.ts                    MCP server — exposes <service>_send, _status, _tts, _send_file tools
    └── watcher/
        ├── cli.ts                  Entry point: `node dist/watcher/cli.js watch`
        ├── index.ts                Watcher orchestrator — hub detection, startup, shutdown
        ├── connection.ts           [YOU IMPLEMENT THIS] Upstream SDK connection
        ├── send.ts                 [YOU IMPLEMENT THIS] Text/voice/file delivery
        ├── commands.ts             Slash command handler (/help, /sessions, /new, etc.)
        ├── ipc-server.ts           IPC server — deliver, health, connection_status, login handlers
        └── state.ts                Connection status, stats, socket path constant
```

**The only files that require service-specific code are `connection.ts` and `send.ts`.** Everything else is scaffolded and works without modification.

---

## How to Test Your Adapter

### 1. Start the watcher

```bash
npm run build
node dist/watcher/cli.js watch
```

Watch for the line:
```
<Service> Adapter Watch
  Socket:  /tmp/my-adapter-watcher.sock
  Mode:    embedded (standalone)
```

If Mode shows `hub (daemon detected)`, the AIBroker daemon is running and will route messages through it.

### 2. Health check

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"health","params":{}}' | socat - UNIX-CONNECT:/tmp/my-adapter-watcher.sock
```

Or using Node:

```bash
node --input-type=module <<'EOF'
import { WatcherClient } from 'aibroker';
const c = new WatcherClient('/tmp/my-adapter-watcher.sock');
console.log(JSON.stringify(await c.call_raw('health', {}), null, 2));
EOF
```

Expected: `"status": "ok"` and `"connectionStatus": "connected"`.

### 3. Send a test message

```bash
node --input-type=module <<'EOF'
import { WatcherClient } from 'aibroker';
const c = new WatcherClient('/tmp/my-adapter-watcher.sock');
const r = await c.call_raw('send', { message: 'Hello from test', recipient: undefined });
console.log(r);
EOF
```

Check the service's UI — the message should appear.

### 4. Trigger login (if connection failed)

```bash
node --input-type=module <<'EOF'
import { WatcherClient } from 'aibroker';
const c = new WatcherClient('/tmp/my-adapter-watcher.sock');
const r = await c.call_raw('login', {});
console.log(r.result?.message);
EOF
```

This calls `triggerLogin()` inside `connection.ts` and prints the QR code URL or OTP prompt.

### 5. Test MCP tools (requires Claude Code restart)

After registering the MCP server in `~/.claude.json` and restarting Claude Code:

```
Use my_adapter_status to check the connection.
Use my_adapter_send with message "Hello" to send a test.
```

---

## Registering with the Hub

The hub routes messages between adapters. Once your adapter is working standalone, register it so the hub can push messages to it.

### 1. Add to hub config

Edit `~/.aibroker/config.json` (create if it does not exist):

```json
{
  "adapters": [
    {
      "name": "my-adapter",
      "socketPath": "/tmp/my-adapter-watcher.sock",
      "autoStart": false
    }
  ]
}
```

Set `"autoStart": true` if you want the daemon to start your adapter's watcher process automatically.

### 2. Register as an MCP server

Add to `~/.claude.json` under `mcpServers`:

```json
"my-adapter": {
  "type": "stdio",
  "command": "node",
  "args": ["/absolute/path/to/my-adapter/dist/index.js"],
  "description": "My Service MCP adapter"
}
```

### 3. Add permissions

Add to `~/.claude/settings.json` under `permissions.allow`:

```json
"mcp__my-adapter"
```

### 4. Restart Claude Code

MCP tool schemas are loaded once at session start. You must start a new Claude Code session for the new tools to appear.

### 5. Verify hub routing

With both the AIBroker daemon and your adapter watcher running, send a message from another adapter's MCP tool targeting your adapter:

```
Use whatsapp_send with message "[To:my-adapter] Hello" to route a message to my adapter.
```

The hub will pick up the `[To:my-adapter]` prefix, look up the registered socket path, and call the `deliver` IPC handler on your adapter.

---

## Common Issues

**"Connection refused" on the socket** — The watcher is not running or crashed on startup. Check `node dist/watcher/cli.js watch` output for errors.

**`connectionStatus: "disconnected"` in health** — `connectWatcher()` returned before the SDK finished connecting. Add an `await client.waitForConnection()` or equivalent before returning from `connectWatcher()`.

**Messages received but `onMessage` never called** — Check the event name. Most SDKs use `'message'`, some use `'text'` or `'messageCreate'`. Read the SDK docs.

**`triggerLogin()` returns but no QR appears** — Print the QR data to the terminal log (`console.log`) during development. Once auth credentials are saved to disk, login is not needed again.

**Hub not detecting the adapter** — Verify the `socketPath` in `~/.aibroker/config.json` matches `ADAPTER_SOCKET_PATH` in `state.ts` exactly (including the `/tmp/` prefix).

**MCP tools not appearing in Claude Code** — Restart the session. MCP schemas load only at startup. Also verify `~/.claude.json` has the `mcpServers` entry and `~/.claude/settings.json` has the `permissions.allow` entry.
