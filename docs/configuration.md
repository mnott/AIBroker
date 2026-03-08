# Configuration

AIBroker stores all runtime state and configuration under `~/.aibroker/`. The daemon also reads environment variables and a launchd plist for automatic startup.

## App Data Directory

Default: `~/.aibroker/`

The directory is created automatically on first run. All paths below are relative to this directory.

To override the directory, call `setAppDir(dir)` from `src/core/persistence.ts` before any load/save operations.

```
~/.aibroker/
├── sessions.json        — Session registry (active sessions, active iTerm tab)
├── voice-config.json    — TTS voice preferences
├── outbox/
│   └── pending.json     — PAILot outbox (messages buffered while app offline)
└── env                  — Environment variables loaded by launchd daemon
```

## sessions.json

Persists the session registry across daemon restarts. The file is written after every session state change.

```json
{
  "activeItermSessionId": "w0t0p0:ABC123-DEF456-...",
  "sessions": [
    {
      "sessionId": "iterm-uuid-of-mcp-client",
      "name": "My Project",
      "itermSessionId": "w0t0p0:ABC123-DEF456-..."
    }
  ]
}
```

The loader handles both the current format and the old format (plain array without `activeItermSessionId`):

```typescript
// Both are valid on disk:
// Old: [{ sessionId, name, itermSessionId }]
// New: { activeItermSessionId, sessions: [...] }
const raw = Array.isArray(parsed) ? parsed : (parsed.sessions ?? []);
```

`activeItermSessionId` restores the previously focused iTerm2 tab after daemon restart.

### Save Triggers

`saveSessionRegistry()` is called after:
- Adapter registration (`register_adapter`)
- Session name changes (`rename`)
- Session switches (`switch`)
- Session termination (`end_session`)

## voice-config.json

TTS preferences. Written by the `voice_config` IPC handler and `aibroker_voice_config` MCP tool.

```json
{
  "defaultVoice": "bm_fable",
  "voiceMode": false,
  "localMode": false,
  "personas": {
    "Nicole": "af_nicole",
    "George": "bm_george",
    "Daniel": "bm_daniel",
    "Fable": "bm_fable"
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `defaultVoice` | `"bm_fable"` | Voice ID used when no voice is specified |
| `voiceMode` | `false` | If true, reply with voice notes by default |
| `localMode` | `false` | If true, also play TTS through Mac speakers |
| `personas` | see above | Persona name → voice ID mapping for multi-persona scenarios |

On load, the file is merged with `DEFAULT_VOICE_CONFIG` so new fields added in future versions get their defaults without breaking existing configs.

## outbox/pending.json

Stores messages buffered for PAILot when no app clients are connected. Written after every change. Restored at gateway startup.

```json
{
  "_global": [
    {
      "type": "text",
      "content": "Build complete.",
      "sessionId": "ABC123",
      "timestamp": 1741420800000
    }
  ],
  "ABC123-DEF456": [
    {
      "type": "voice",
      "audioBase64": "...",
      "transcript": "Hello from Claude.",
      "sessionId": "ABC123",
      "timestamp": 1741420801000
    }
  ]
}
```

Limits: `MAX_OUTBOX_PER_SESSION=50` messages per session. `TYPING` messages are never buffered. `IMAGE` messages are counted (`missedImageCount`) but not stored (too large).

## env File

The daemon reads `~/.aibroker/env` to load environment variables when started as a launchd service (where the shell profile is not sourced).

Format: one `KEY=value` per line. Lines starting with `#` are comments.

```bash
# TTS voice selection
AIBROKER_TTS_VOICE=bm_fable

# Whisper model
AIBROKER_WHISPER_MODEL=small

# Replicate API key (for image generation)
REPLICATE_API_KEY=r8_...

# PAILot WebSocket port (default: 8765)
PAILOT_PORT=8765

# Enable verbose PAILot debug logging
# PAILOT_DEBUG=1
```

## Environment Variables

Variables that control AIBroker behavior at startup:

| Variable | Default | Description |
|----------|---------|-------------|
| `AIBROKER_TTS_VOICE` | `"bm_fable"` | Default TTS voice ID |
| `MSGBRIDGE_TTS_VOICE` | — | Legacy alias for TTS voice |
| `WHAZAA_TTS_VOICE` | — | Legacy alias for TTS voice |
| `AIBROKER_WHISPER_MODEL` | `"small"` | Whisper model size (`tiny`, `base`, `small`, `medium`, `large`) |
| `MSGBRIDGE_WHISPER_MODEL` | — | Legacy alias for Whisper model |
| `WHAZAA_WHISPER_MODEL` | — | Legacy alias for Whisper model |
| `PAILOT_PORT` | `8765` | PAILot WebSocket gateway port |
| `PAILOT_DEBUG` | — | Set to `1` for verbose WS debug logging to `/tmp/pailot-ws-debug.log` |

## MCP Server Configuration

The unified MCP server must be registered in `~/.claude.json` under the top-level `mcpServers` key:

```json
{
  "mcpServers": {
    "aibroker": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/AIBroker/dist/mcp/index.js"],
      "description": "AIBroker unified MCP server — WhatsApp, Telegram, PAILot, session management"
    }
  }
}
```

Do not register this in `~/.claude/.mcp.json` — that file is not read by Claude Code for MCP loading.

The `enabledMcpjsonServers` array in `~/.claude/settings.json` controls which MCP servers are active in the current session.

## launchd Service

AIBroker runs as a launchd service for automatic startup at login. The plist references `~/.aibroker/env` for environment configuration.

Typical plist location: `~/Library/LaunchAgents/com.aibroker.daemon.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "...">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.aibroker.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/path/to/node</string>
    <string>/path/to/AIBroker/dist/daemon/index.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AIBROKER_ENV_FILE</key>
    <string>/Users/yourname/.aibroker/env</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/aibroker.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/aibroker-err.log</string>
</dict>
</plist>
```

## Adapter Socket Paths

The hub auto-discovers adapters by probing known socket paths at startup:

```typescript
// From src/daemon/index.ts
const KNOWN_ADAPTERS = [
  { name: "whazaa", socketPath: "/tmp/whazaa-watcher.sock" },
  { name: "telex",  socketPath: "/tmp/telex-watcher.sock" },
];
```

If the socket exists and responds to a `health` call within 3 seconds, the adapter is registered. This means adapters can be started before or after the hub — the hub will discover them at startup, and adapters can register themselves by calling `register_adapter` at any time.

## PAILot Outbox Directory

The outbox directory is created automatically:

```
~/.aibroker/outbox/
└── pending.json
```

Messages are written to `pending.json` after every `addToOutbox()` call. The file is read at PAILot gateway startup and drained when a client connects and sends `sync`.

## Debug Logging

Set `PAILOT_DEBUG=1` in `~/.aibroker/env` for verbose PAILot WebSocket logging:

```
/tmp/pailot-ws-debug.log
```

Logs include every raw WebSocket message (truncated to 200 chars), voice message receipt, audio file paths and byte counts.

Hub daemon logs go to stdout/stderr (captured by launchd at `/tmp/aibroker.log`).
