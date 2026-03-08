# Development Guide

## Repository Layout

```
AIBroker/
├── src/
│   ├── adapters/
│   │   ├── iterm/        — iTerm2 AppleScript integration (sessions, keystrokes, screenshots)
│   │   ├── kokoro/       — TTS (tts.ts) and STT/media (media.ts)
│   │   ├── pailot/       — PAILot WebSocket gateway
│   │   └── session/      — Claude API session backend (api.ts → src/backend/)
│   ├── aibp/             — AIBP routing protocol (types, registry, bridge, envelope)
│   ├── backend/          — APIBackend: headless Claude subprocess sessions
│   ├── core/             — Shared utilities: log, state, persistence, router, markdown
│   ├── daemon/           — Hub daemon: index, commands, core-handlers, adapter-registry
│   ├── ipc/              — Unix socket server, client, and validation layer
│   ├── mcp/              — Unified MCP server (42 tools)
│   └── types/            — Shared TypeScript interfaces
├── templates/
│   └── adapter/          — Scaffold for new adapters ({{ADAPTER_NAME}} placeholders)
├── test/                 — Unit tests (node:test runner)
├── docs/                 — This documentation
├── dist/                 — Compiled output (git-ignored)
└── package.json
```

## Build

```bash
npm install
npm run build        # tsc → dist/
```

TypeScript compiles to `dist/`. Entry points:
- `dist/daemon/index.js` — Hub daemon
- `dist/mcp/index.js` — Unified MCP server

## Test

```bash
npm test
# or
npx tsx --test test/*.test.ts
```

Tests use the built-in `node:test` runner with zero external test framework dependencies. All tests are in `test/`, currently 83 tests across 6 files.

Test files:
- `test/aibp.test.ts` — AIBP registry routing logic
- `test/aibp-bridge.test.ts` — AibpBridge convenience wrapper
- `test/validate.test.ts` — IPC response validation
- `test/hybrid.test.ts` — HybridSessionManager
- `test/status-cache.test.ts` — StatusCache
- `test/media.test.ts` — Text chunking for TTS

## Local Development with Consumer Repos

AIBroker is consumed by Whazaa and Telex as an npm dependency. For local development without publishing:

```bash
# 1. In AIBroker repo
npm link

# 2. In Whazaa or Telex repo
npm link aibroker

# 3. Build AIBroker after changes
cd /path/to/AIBroker
npm run build

# 4. Whazaa/Telex picks up the new dist/ automatically (symlinked)
```

Related repos:
- Whazaa: `~/dev/ai/Whazaa` — WhatsApp adapter
- Telex: `~/dev/ai/Telex` — Telegram adapter

## Hard Rules

From `CLAUDE.md`:

1. **NEVER import platform-specific libraries in AIBroker:**
   - `@whiskeysockets/baileys` — stays in Whazaa
   - `gramjs` — stays in Telex
   - `better-sqlite3` — stays in adapters that need it
   - `qrcode` — stays in adapters that need it

2. **Changes here affect both Whazaa and Telex** — test both after modifications to shared code.

3. **Package name**: `aibroker` (unscoped, public npm).

## Code Conventions

### TypeScript

- Strict mode enabled (`tsconfig.json`)
- Node.js built-in imports use `node:` prefix: `import { existsSync } from "node:fs"`
- ES module output (`"type": "module"` in package.json)
- Imports use `.js` extension (required for ESM compatibility even in `.ts` source)

### IPC Handlers

All IPC handlers in `src/daemon/core-handlers.ts` follow the same pattern:

```typescript
server.on("my_handler", async (req) => {
  const { param1, param2 } = req.params as { param1?: string; param2?: number };

  // Validate required params
  if (!param1) return { ok: false, error: "param1 is required" };

  // Do work
  const result = await doWork(param1, param2);

  // Return success
  return { ok: true, result: { field: result } };
});
```

Always return `{ ok: false, error: "..." }` for validation errors rather than throwing. The IPC server wraps uncaught exceptions but explicit error returns give better messages.

### Adding a New IPC Handler

1. Add the handler in `src/daemon/core-handlers.ts`
2. Add a corresponding MCP tool in `src/mcp/index.ts` (if it should be Claude-accessible)
3. Add the IPC method to `docs/ipc.md`
4. Add the MCP tool to `docs/mcp-tools.md`

### Adding a New Slash Command

1. Add a match check in `handleMessage()` in `src/daemon/commands.ts`
2. Use `ctx.reply()`, `ctx.replyImage()`, or `ctx.replyVoice()` — never call adapter-specific functions
3. Add `return` after handling to prevent fall-through to plain text delivery
4. Add the command to the `/h` help text in the same file
5. Add the command to `docs/commands.md`

For commands that require keyboard access (iTerm2), check `hybridManager?.activeSession?.kind` and reject API sessions:

```typescript
if (session.kind !== "visual") {
  ctx.reply("This command requires a visual session.").catch(() => {});
  return;
}
```

### AIBP Message Types

The AIBP protocol supports these message types (`AibpMessageType`):

| Type | Description |
|------|-------------|
| `TEXT` | Plain text message |
| `VOICE` | Voice note (audio buffer as base64) |
| `IMAGE` | Image (buffer as base64, optional caption) |
| `COMMAND` | Slash command |
| `FILE` | File attachment |

### CommandContext

Always use `CommandContext` methods for replies. Never call adapter IPC directly from command handlers:

```typescript
interface CommandContext {
  reply(text: string): Promise<void>;
  replyImage(imageBuffer: Buffer, caption: string): Promise<void>;
  replyVoice(audioBuffer: Buffer, caption: string): Promise<void>;
  source: string;      // "pailot" | "telex" | "whazaa" | "hub"
  recipient?: string;
}
```

## Creating a New Adapter

Use the scaffold in `templates/adapter/`. See [adapters.md](./adapters.md) for the full guide. The essential files:

```
src/watcher/
├── index.ts          — Entry point: connect + IPC server + hub registration
├── connection.ts     — Platform SDK connection (implement connectWatcher())
├── ipc-server.ts     — IPC handlers: deliver, health, connection_status
├── send.ts           — sendText(), sendVoice(), sendFile()
├── state.ts          — Shared state + socket paths
└── cli.ts            — CLI: start, stop, status, restart
```

Template placeholders: `{{ADAPTER_NAME}}` and `{{DISPLAY_NAME}}`.

### Required IPC Handlers

Every adapter must implement:
- `deliver` — Hub pushes outbound messages to the adapter
- `health` — Hub polls every 60s for `{ status, connectionStatus, stats, lastMessageAgo }`
- `connection_status` — Returns current upstream connection state

See [adapters.md](./adapters.md) for the complete handler signatures.

## Debugging

### Hub Daemon

Logs go to stdout. With launchd: `/tmp/aibroker.log`

Key log lines:
- `IPC server listening on /tmp/aibroker.sock` — Hub started
- `Registered adapter: whazaa at /tmp/whazaa-watcher.sock` — Adapter connected
- `[AIBP] Routing TEXT mobile:pailot → session:UUID` — AIBP message routed
- `[AIBP] MESH FAIL: no bridge plugin for hub:name` — Mesh routing failed

### PAILot Gateway

Enable verbose logging: `PAILOT_DEBUG=1` in `~/.aibroker/env`

Log file: `/tmp/pailot-ws-debug.log`

Logged events:
- Every raw WebSocket message (truncated to 200 chars)
- Voice message receipt and base64 audio length
- Audio file save paths and byte counts

### AIBP State

Use the `aibroker_aibp_status` MCP tool to inspect the current AIBP registry:

```
aibroker_aibp_status()
→ {
    plugins: [{ address, type, name, sessionName? }],
    channels: [{ name, members, outboxSize }],
    commands: [{ name, owner, description }]
  }
```

### IPC Testing

Test IPC handlers directly with `nc`:

```bash
echo '{"id":"1","sessionId":"test","method":"status","params":{}}' | nc -U /tmp/aibroker.sock
```

### Adapter Health

Check adapter health directly:

```bash
echo '{"id":"1","sessionId":"test","method":"health","params":{}}' | nc -U /tmp/whazaa-watcher.sock
```

## Version and Package

Package name: `aibroker` (public, unscoped npm)
Current version: `0.6.0`

The version is in `package.json`. Update it before publishing. Both Whazaa and Telex pin to `aibroker@^0.1.0` or similar — check their `package.json` files before bumping a major version.

## Two Repository Layout

The development repo (`~/dev/ai/AIBroker`) and the cloud-synced repo (`~/Daten/Cloud/Development/ai/AIBroker`) are kept in sync:

- Code changes happen in the dev repo
- `git push` from dev repo
- Cloud repo does `git fetch` + `git reset --hard`
- Notes and TODO.md live in the cloud repo

From `MEMORY.md`:
```
Dev repo:   /Users/i052341/dev/ai/AIBroker     (builds, git ops)
Cloud repo: /Users/i052341/Daten/Cloud/Development/ai/AIBroker  (synced)
```
