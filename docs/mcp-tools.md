# MCP Tools Reference

AIBroker exposes 42 MCP tools through a single unified server (`src/mcp/index.ts`). The server connects to the hub daemon at `/tmp/aibroker.sock` and proxies most tool calls through the hub via IPC.

## Architecture

```
Claude Code ──► MCP: aibroker (stdio)
                         │
                         ├─ aibroker_* tools: direct hub IPC calls
                         ├─ whatsapp_* tools: hub.adapter_call("whazaa", ...)
                         ├─ telegram_* tools: hub.adapter_call("telex", ...)
                         └─ pailot_* tools: direct hub IPC calls
```

The MCP server has no platform-specific code. All adapter communication goes through the hub's `adapter_call` IPC handler, which proxies the call to the correct adapter socket. See [ipc.md](./ipc.md) for the `adapter_call` protocol.

## Session Identity

At startup, the MCP server determines which iTerm2 session it belongs to via two methods:

1. `ITERM_SESSION_ID` environment variable (set automatically by iTerm2 — most reliable)
2. TTY walk: traverse the process tree to find the TTY, then ask iTerm2 via AppleScript which session owns it

The resolved session ID is cached and included in relevant tool calls (especially `pailot_send`) so replies route back to the correct session.

The MCP also registers itself with the hub via `aibp_register` so it appears as an AIBP plugin (type `mcp`) and joins the session channel for bidirectional messaging.

## Message Routing Rules (MCP System Prompt)

The MCP server injects routing rules into its system instructions. These are critical for correct behavior:

| Message prefix | Source | Reply with |
|----------------|--------|------------|
| `[Whazaa]` | Text from WhatsApp | `whatsapp_send` |
| `[Whazaa:voice]` | Voice from WhatsApp | `whatsapp_tts` |
| `[Telex]` | Text from Telegram | `telegram_send` |
| `[Telex:voice]` | Voice from Telegram | `telegram_tts` |
| `[PAILot]` | Text from PAILot app | `pailot_send` |
| `[PAILot:voice]` | Voice from PAILot app | `pailot_tts` |
| _(no prefix)_ | Terminal keyboard input | Terminal only — do NOT send to any channel |

Rules:
- Strip the prefix before processing the message
- Match the medium: text in → text out, voice in → voice out
- For `whatsapp_send` / `telegram_send`: use `**bold**` and `*italic*` only — no headers, no code blocks
- For TTS tools: no markdown whatsoever — asterisks are spoken literally
- Acknowledge long tasks immediately before starting work (send a brief ack first)

## MCP Configuration

```json
// In ~/.claude.json under "mcpServers"
"aibroker": {
  "type": "stdio",
  "command": "node",
  "args": ["/path/to/AIBroker/dist/mcp/index.js"]
}
```

---

## aibroker_* Tools (17 tools) — Hub-Level

These tools call the hub daemon directly. They work regardless of which adapters are connected.

### `aibroker_status`

Hub health overview: version, registered adapters, session count, adapter health.

**Parameters:** none

**Returns:** JSON with `version`, `adapters[]`, `activeSessions`, `activeSession`, `adapterHealth{}`.

```json
// Example response
{
  "version": "0.6.0",
  "adapters": ["whazaa", "telex"],
  "activeSessions": 2,
  "activeSession": "My Project",
  "adapterHealth": {
    "whazaa": { "status": "ok", "connectionStatus": "connected" }
  }
}
```

---

### `aibroker_aibp_status`

AIBP routing fabric state: all registered plugins, channel memberships, registered commands.

**Parameters:** none

**Returns:** `{ plugins[], channels[], commands[] }` — see [ipc.md#aibp_status](./ipc.md) for shape.

Useful for debugging routing issues. Shows which sessions have MCP plugins registered, which AIBP channels are active, and which slash commands are registered.

---

### `aibroker_adapters`

List all adapters currently registered with the hub.

**Parameters:** none

**Returns:** `{ adapters: [{ name, socketPath }] }`

---

### `aibroker_sessions`

List all Claude sessions managed by the hub's `HybridSessionManager`.

**Parameters:** none

**Returns:**

```json
{
  "sessions": [
    { "index": 1, "name": "My Project", "kind": "api", "active": false, "cwd": "/Users/me/project" },
    { "index": 2, "name": "Claude Tab", "kind": "visual", "active": true, "cwd": "/Users/me/project" }
  ],
  "activeIndex": 2
}
```

`kind` is either `"api"` (headless subprocess) or `"visual"` (iTerm2 tab).

---

### `aibroker_switch`

Switch the active Claude session.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `target` | string | Session number (1-based) or name substring |

**Returns:** `"Switched to <name>"`

---

### `aibroker_end_session`

End and remove a Claude session. For visual sessions, closes the iTerm2 tab.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `target` | string | Session number or name substring |

**Returns:** `"Ended session <name>"`

---

### `aibroker_rename`

Rename the current Claude session. Updates both the hub registry and all adapter registries (forwarded via IPC). For visual sessions, also updates the iTerm2 tab title.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `name` | string | New session name (min 1 char) |

**Returns:** `"Session renamed to \"<name>\""`

---

### `aibroker_discover`

Trigger a re-scan of iTerm2 sessions. Forwards to the first registered adapter. Useful after manually opening new Claude tabs.

**Parameters:** none

**Returns:** Forwarded adapter response with updated session list.

---

### `aibroker_voice_config`

Get or update TTS voice configuration.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `action` | `"get"` \| `"set"` | Operation |
| `defaultVoice` | string? | Default voice ID (e.g. `"bm_fable"`) |
| `voiceMode` | boolean? | Enable/disable voice mode globally |
| `localMode` | boolean? | Play TTS through Mac speakers locally |
| `personas` | `Record<string, string>`? | Persona → voice mapping |

**Returns:** Current configuration as JSON.

Voice config persists to `~/.aibroker/voice-config.json`. Default personas: Nicole, George, Daniel, Fable.

---

### `aibroker_speak`

Speak text aloud through Mac speakers using Kokoro TTS. Local playback only — does not send to any messaging channel.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `text` | string | Text to speak |
| `voice` | string? | Voice name (e.g. `"bm_fable"`, `"af_bella"`) |

**Returns:** `"Speaking."`

For the list of available voices see [tts-stt.md](./tts-stt.md).

---

### `aibroker_dictate`

Record from the Mac microphone, transcribe with Whisper, and return the text. Stops automatically after ~2 seconds of silence.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `maxDuration` | number? | Max recording seconds, 5–300 (default 60) |

**Returns:** `"Transcribed: <text>"` or `"No speech detected."`

---

### `aibroker_generate_image`

Generate an image from a text prompt using Replicate Flux.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `prompt` | string | Image description |
| `source` | string? | Adapter to deliver result to (`"whazaa"`) |
| `recipient` | string? | Recipient within that adapter |
| `width` | number? | Image width in pixels |
| `height` | number? | Image height in pixels |

**Returns:** `{ imageUrl, delivered }` or error.

---

### `aibroker_command`

Execute a slash command directly through the hub command handler. Equivalent to typing the command from WhatsApp or PAILot.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `text` | string | The slash command, e.g. `"/s"`, `"/ss"`, `"/restart"` |

**Returns:** `"Executed: <command>"`

---

### `aibroker_pai_projects`

List all PAI named projects available for launch.

**Parameters:** none

**Returns:**

```json
{
  "projects": [
    { "name": "AIBroker", "slug": "aibroker", "path": "/Users/me/dev/AIBroker", "sessions": 1 }
  ]
}
```

---

### `aibroker_pai_launch`

Launch a PAI named project in a new iTerm2 tab running Claude Code.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `name` | string | Project name or slug |

**Returns:** `{ launched: true, session: "..." }`

---

### `aibroker_session_content`

Read raw terminal output from one or all Claude Code sessions. Returns the last N lines plus a busy/idle flag and a change indicator.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `sessionId` | string? | iTerm2 session ID. Omit to read all sessions. |
| `lines` | number? | Lines to read, 10–500 (default 100) |

**Returns (single session):**

```json
{
  "session": {
    "sessionId": "ABC123",
    "name": "My Project",
    "content": "...terminal lines...",
    "atPrompt": false,
    "contentHash": "a1b2c3d4",
    "changed": true,
    "cachedSummary": null,
    "cachedAt": null
  }
}
```

**Returns (all sessions):** Same shape per-session inside `"sessions": [...]`.

**Usage pattern:**
1. Call with no `sessionId` to get all sessions
2. If `changed` is `true`: parse `content` and call `aibroker_cache_status` to store the summary
3. If `changed` is `false`: use `cachedSummary` directly — skip re-parsing

---

### `aibroker_cache_status`

Store a parsed summary for a session. Must be called after `aibroker_session_content` if `changed` is `true`.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `sessionId` | string | iTerm2 session ID |
| `sessionName` | string? | Human-readable name |
| `summary` | string | 1–2 sentence description of what the session is doing |
| `contentHash` | string? | The `contentHash` from `session_content` (for change detection) |
| `state` | `"idle"` \| `"busy"` \| `"error"` \| `"disconnected"`? | Session state |

**Returns:** `{ cached: true, sessionId: "..." }`

---

### `aibroker_get_cached_status`

Retrieve stored summaries without re-probing terminal content. Fast lookup.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `sessionId` | string? | Omit to get all cached snapshots |

**Returns (single):** `{ snapshot: { sessionId, sessionName, timestamp, state, summary, contentHash, lastProbeAt } }`

**Returns (all):** `{ snapshots: [...] }`

---

## whatsapp_* Tools (11 tools) — Proxied to Whazaa

These tools call `hub.adapter_call("whazaa", method, params)` internally. They fail if the Whazaa adapter is not running.

### `whatsapp_status`

Check WhatsApp connection state.

**Parameters:** none

**Returns:** `"Connected. Phone: +41791234567"` or `"Awaiting QR scan."` or `"Disconnected."`

---

### `whatsapp_send`

Send a WhatsApp message. **Only call when the incoming message had a `[Whazaa]` prefix.**

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `message` | string | Message text |
| `recipient` | string? | Phone number, JID, or contact name. Omit for self-chat. |
| `voice` | string? | Send as TTS voice note. `"true"` or `"default"` for default voice, or a voice name. |
| `channel` | `"whatsapp"` \| `"pailot"`? | `"pailot"` sends only to PAILot app, not WhatsApp. |

**Returns:** `"Sent."`

---

### `whatsapp_tts`

Convert text to speech and send as a WhatsApp voice note. **Only call when the incoming message had a `[Whazaa:voice]` prefix.**

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `message` | string | Text to speak |
| `voice` | string? | Voice name |
| `recipient` | string? | Phone, JID, or name. Omit for self-chat. |
| `channel` | `"whatsapp"` \| `"pailot"`? | Delivery channel |

**Returns:** `"Sent."` or `"Sent 3 voice notes."` (for long texts split into chunks)

---

### `whatsapp_send_file`

Send a file via WhatsApp.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `filePath` | string | Absolute path to the file |
| `recipient` | string? | Phone, JID, or name. Omit for self-chat. |
| `caption` | string? | Caption text |
| `prettify` | boolean? | Convert `.txt`/`.md` files to WhatsApp-formatted messages |

**Returns:** `"Sent."`

---

### `whatsapp_receive`

Drain the queue of incoming WhatsApp messages.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `from` | string? | Sender filter: phone, JID, name, or `"all"`. Omit for self-chat only. |

**Returns:** Messages as `"[timestamp] body"` lines, or `"No new messages."`

---

### `whatsapp_contacts`

List recently seen WhatsApp contacts.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `search` | string? | Filter by name or phone |
| `limit` | number? | Max results (default 50, max 200) |

**Returns:** `"N contact(s):\nName +phone (jid)"` lines.

---

### `whatsapp_chats`

List WhatsApp chat conversations.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `search` | string? | Filter by name or phone |
| `limit` | number? | Max results (default 50, max 200) |

**Returns:** `"N chat(s):\nName (jid) [N unread]"` lines.

---

### `whatsapp_history`

Fetch message history for a specific WhatsApp chat.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `jid` | string | Chat JID or phone number |
| `count` | number? | Number of messages (default 50, max 500) |

**Returns:** `"N message(s):\n[date] Me/Them: text"` lines.

---

### `whatsapp_wait`

Long-poll for the next incoming WhatsApp message. Blocks until a message arrives or timeout.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `timeout` | number? | Max seconds to wait, 1–300 (default 120) |

**Returns:** Messages as lines, or `"No messages received (timed out)."`

---

### `whatsapp_login`

Trigger a new WhatsApp QR pairing flow. The QR code appears in the Whazaa watcher terminal.

**Parameters:** none

**Returns:** `"Login flow triggered. Check watcher terminal for QR."`

---

### `whatsapp_restart`

Restart the Whazaa WhatsApp watcher service via launchd.

**Parameters:** none

**Returns:** Service restart status as JSON.

---

## telegram_* Tools (11 tools) — Proxied to Telex

These tools call `hub.adapter_call("telex", method, params)`. They fail if the Telex adapter is not running.

### `telegram_status`

Check Telegram connection status.

**Parameters:** none

**Returns:** Connection status as JSON.

---

### `telegram_send`

Send a text message via Telegram. **Only call when the incoming message had a `[Telex]` prefix.**

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `message` | string | Message text |
| `recipient` | string? | Username, phone, chat ID, or name. Default: Saved Messages. |
| `voice` | boolean? | If true, send as TTS voice note |

**Returns:** `"Sent."`

---

### `telegram_tts`

Send a voice note via Telegram. **Only call when the incoming message had a `[Telex:voice]` prefix.**

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `text` | string | Text to speak |
| `recipient` | string? | Recipient. Default: Saved Messages. |
| `voice` | string? | Voice name |

**Returns:** `"Sent."` or `"Sent N voice notes."`

---

### `telegram_send_file`

Send a file via Telegram.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `filePath` | string | Absolute path to the file |
| `recipient` | string? | Recipient. Default: Saved Messages. |
| `caption` | string? | Caption text |
| `prettify` | boolean? | Convert text/md to formatted Telegram messages |

**Returns:** `"Sent."`

---

### `telegram_receive`

Drain queued incoming Telegram messages.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `from` | string? | Source filter: omit for self, `"all"` for all, or chat ID/name |

**Returns:** Messages as `"[timestamp] body"` lines, or `"No new messages."`

---

### `telegram_contacts`

List Telegram contacts.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `search` | string? | Filter by name or username |
| `limit` | number? | Max results |

**Returns:** Contacts as JSON.

---

### `telegram_chats`

List Telegram chats.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `search` | string? | Filter |
| `limit` | number? | Max results (default 50) |

**Returns:** Chats as JSON.

---

### `telegram_wait`

Long-poll for incoming Telegram messages.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `timeoutMs` | number? | Max wait in milliseconds (default 120000) |

**Returns:** Messages as lines, or `"No messages received (timed out)."`

---

### `telegram_history`

Get message history for a Telegram chat.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `chatId` | string | Chat ID, username, or `"me"` for Saved Messages |
| `count` | number? | Number of messages (default 20) |

**Returns:** `"N message(s):\n[date] Me/Them: text"` lines.

---

### `telegram_login`

Trigger fresh Telegram authentication.

**Parameters:** none

**Returns:** Authentication status as JSON.

---

### `telegram_restart`

Restart the Telex Telegram watcher service.

**Parameters:** none

**Returns:** Service restart status as JSON.

---

## pailot_* Tools (3 tools) — Direct Hub Calls

These tools call the hub directly (not via `adapter_call`) since PAILot is served by the hub WebSocket gateway rather than an external adapter. They include the MCP's resolved session ID so replies route to the correct PAILot client.

### `pailot_send`

Send a text message to the PAILot mobile app. **Only call when the incoming message had a `[PAILot]` prefix.**

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `message` | string | Message text |

**Returns:** `"Sent."`

Internally calls `hub.pailot_send({ text, sessionId })` where `sessionId` is the MCP's resolved iTerm2 session.

---

### `pailot_tts`

Send a voice note to the PAILot mobile app. **Only call when the incoming message had a `[PAILot:voice]` prefix.** Uses Kokoro TTS for synthesis.

**Parameters:**

| Name | Type | Description |
|------|------|-------------|
| `message` | string | Text to speak |
| `voice` | string? | Voice name |

**Returns:** `"Sent."` or `"Sent N voice notes."`

Internally calls `hub.pailot_send({ text, voice: true, voiceName, sessionId })`.

---

### `pailot_receive`

Drain the queue of incoming PAILot messages.

**Parameters:** none

**Returns:** Messages as `"[timestamp] body"` lines, or `"No new messages."`

---

## Tool Count Summary

| Group | Count | Backend |
|-------|-------|---------|
| `aibroker_*` | 17 | Hub IPC direct |
| `whatsapp_*` | 11 | `adapter_call("whazaa", ...)` |
| `telegram_*` | 11 | `adapter_call("telex", ...)` |
| `pailot_*` | 3 | Hub IPC direct |
| **Total** | **42** | |

## Related Documentation

- [ipc.md](./ipc.md) — IPC wire protocol and hub handler reference
- [adapters.md](./adapters.md) — Adapter architecture and `adapter_call` proxy
- [pailot.md](./pailot.md) — PAILot gateway and WebSocket protocol
- [tts-stt.md](./tts-stt.md) — Kokoro TTS and Whisper STT pipeline
- [sessions.md](./sessions.md) — Session orchestration with `session_content` / `cache_status`
