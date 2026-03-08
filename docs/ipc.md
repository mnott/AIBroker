# IPC Protocol

AIBroker's hub daemon communicates with MCP clients, adapters, and internal components over Unix Domain Sockets using NDJSON (newline-delimited JSON). Every call follows a single request/response envelope.

## Wire Format

### Transport

```
/tmp/aibroker.sock    — hub daemon (all IPC calls go here)
/tmp/whazaa-watcher.sock  — Whazaa adapter IPC server
/tmp/telex-watcher.sock   — Telex adapter IPC server
```

Each connection carries exactly one request/response pair. The server closes the socket after writing the response. Clients write one JSON object followed by `\n`, read one JSON object followed by `\n`, then close.

### Request Envelope

```typescript
interface IpcRequest {
  id: string;                        // Caller-assigned correlation ID
  sessionId: string;                 // Calling session's ID
  itermSessionId?: string;           // iTerm2 UUID (if calling from a visual session)
  method: string;                    // Handler name
  params: Record<string, unknown>;   // Method-specific parameters
}
```

The `sessionId` field enables the hub to auto-register unknown sessions on first contact. An MCP process running in a new iTerm2 tab self-registers just by making any IPC call.

### Response Envelope

```typescript
interface IpcResponse {
  id: string;       // Echoes the request id
  ok: boolean;
  result?: Record<string, unknown>;  // Present when ok=true
  error?: string;                    // Present when ok=false
}
```

### Auto-Registration

Every incoming request triggers session auto-registration if the `sessionId` is not already known:

```typescript
// From src/ipc/server.ts
if (req.method !== "register" && !sessionRegistry.has(req.sessionId)) {
  sessionRegistry.set(req.sessionId, {
    sessionId: req.sessionId,
    name: "Auto-registered",
    itermSessionId: req.itermSessionId,
    registeredAt: Date.now(),
  });
}
```

This means MCP clients (and adapters) self-register on first use without an explicit registration step.

## Validation Layer

Source: `src/ipc/validate.ts`

IPC responses arrive as `Record<string, unknown>`. Callers should not cast them directly. The validation module provides typed coercions that return safe defaults on malformed input rather than throwing:

```typescript
// Coerce an adapter health response — returns a "down" object if shape is wrong
validateAdapterHealth(raw: unknown): AdapterHealth

// Validate a sessions list response
validateSessionList(raw: unknown): ValidatedSession[]

// Validate a hub status response
validateHubStatus(raw: unknown): ValidatedHubStatus

// Validate a TTS result
validateTtsResult(raw: unknown): ValidatedTtsResult

// Validate a transcription result
validateTranscription(raw: unknown): ValidatedTranscription
```

## Client

Source: `src/ipc/client.ts`

The `WatcherClient` class sends a single request and reads the response:

```typescript
const client = new WatcherClient("/tmp/aibroker.sock");
const result = await client.call_raw("status", {});
```

## Hub IPC Handlers

All handlers live in `src/daemon/core-handlers.ts` and are registered on the `IpcServer` instance at daemon startup.

### Status and Health

#### `ping`

Liveness check. Returns immediately.

```json
// Request
{ "method": "ping", "params": {} }

// Response
{ "ok": true, "result": { "pong": true } }
```

#### `status`

Hub health overview.

```json
// Response
{
  "ok": true,
  "result": {
    "version": "0.6.0",
    "adapters": ["whazaa", "telex"],
    "activeSessions": 2,
    "activeSession": "My Project",
    "adapterHealth": {
      "whazaa": {
        "status": "ok",
        "connectionStatus": "connected",
        "stats": { "messagesReceived": 42, "messagesSent": 18, "errors": 0 },
        "lastMessageAgo": 3000
      }
    }
  }
}
```

### Adapter Lifecycle

#### `register_adapter`

Called by an adapter at startup to announce itself to the hub.

```json
// Request params
{ "name": "whazaa", "socketPath": "/tmp/whazaa-watcher.sock" }

// Response
{ "ok": true, "result": { "registered": true } }
```

#### `unregister_adapter`

Called by an adapter on clean shutdown.

```json
// Request params
{ "name": "whazaa" }
```

#### `adapter_list`

List all currently registered adapters.

```json
// Response
{
  "ok": true,
  "result": {
    "adapters": [
      { "name": "whazaa", "socketPath": "/tmp/whazaa-watcher.sock" },
      { "name": "telex", "socketPath": "/tmp/telex-watcher.sock" }
    ]
  }
}
```

#### `adapter_call`

Proxy an arbitrary IPC call to a named adapter. Used by the unified MCP server to reach adapter-specific methods without knowing socket paths.

```json
// Request params
{
  "adapter": "whazaa",
  "method": "send",
  "params": { "message": "Hello", "recipient": "+41791234567" }
}

// Response: forwarded adapter response
{ "ok": true, "result": { "delivered": true } }
```

Error if adapter is not registered:

```json
{ "ok": false, "error": "Adapter 'whazaa' not registered. Is the whazaa daemon running?" }
```

### Session Management

#### `sessions`

List all sessions managed by `HybridSessionManager`.

```json
// Response
{
  "ok": true,
  "result": {
    "sessions": [
      { "index": 1, "name": "My Project", "kind": "api", "active": false, "cwd": "/Users/me/project" },
      { "index": 2, "name": "Claude Tab", "kind": "visual", "active": true, "cwd": "/Users/me/project" }
    ],
    "activeIndex": 2
  }
}
```

#### `switch`

Switch the active Claude session by index number or name substring.

```json
// Request params
{ "target": "2" }        // switch to session 2
{ "target": "Backend" }  // switch to session whose name contains "Backend"

// Response
{ "ok": true, "result": { "name": "Backend API", "index": 2 } }
```

#### `end_session`

End and remove a session. For visual sessions, closes the iTerm2 tab.

```json
// Request params
{ "target": "3" }

// Response
{ "ok": true, "result": { "name": "Other Work", "removed": true } }
```

#### `rename`

Rename the active session in the hub and forward to all registered adapters (best effort).

```json
// Request params
{ "name": "New Name" }

// Response
{ "ok": true, "result": { "success": true, "name": "New Name" } }
```

#### `discover`

Proxy to the first available adapter to trigger an iTerm2 session re-scan.

```json
// Response: forwarded from adapter
{ "ok": true, "result": { "sessions": [...] } }
```

### Voice / TTS / STT

#### `voice_config`

Get or update TTS configuration.

```json
// Get
{ "action": "get" }

// Set
{
  "action": "set",
  "defaultVoice": "bm_fable",
  "voiceMode": true,
  "localMode": false,
  "personas": { "Nicole": "af_nicole", "George": "bm_george" }
}

// Response (get)
{
  "ok": true,
  "result": {
    "defaultVoice": "bm_fable",
    "voiceMode": true,
    "localMode": false,
    "personas": { "Nicole": "af_nicole", "George": "bm_george", "Daniel": "bm_daniel", "Fable": "bm_fable" }
  }
}
```

#### `speak`

Convert text to speech and play through Mac speakers. Local only — does not send to any messaging channel.

```json
// Request params
{ "text": "Hello from AIBroker", "voice": "af_bella" }

// Response
{ "ok": true, "result": { "spoken": true } }
```

#### `tts`

Convert text to speech and return the audio buffer as base64. Used internally.

```json
// Request params
{ "text": "Hello", "voice": "bm_fable" }

// Response
{ "ok": true, "result": { "generated": true, "voice": "bm_fable", "audioBase64": "..." } }
```

#### `dictate`

Record from the Mac microphone and transcribe with Whisper. Stops after ~2 seconds of silence.

```json
// Request params
{ "maxDuration": 60 }

// Response
{ "ok": true, "result": { "text": "transcribed speech here" } }
```

#### `transcribe`

Transcribe an audio file from disk.

```json
// Request params
{ "audioPath": "/tmp/my-audio.m4a" }

// Response
{ "ok": true, "result": { "text": "transcribed text" } }
```

#### `list_voices`

Return the full list of available Kokoro TTS voices.

```json
// Response
{
  "ok": true,
  "result": {
    "voices": [
      { "id": "af_bella", "name": "Bella", "gender": "female", "accent": "american" },
      { "id": "bm_george", "name": "George", "gender": "male", "accent": "british" }
    ]
  }
}
```

### Media Generation

#### `generate_image`

Generate an image from a text prompt using Replicate Flux.

```json
// Request params
{
  "prompt": "a cyberpunk cat in Tokyo",
  "source": "whazaa",
  "recipient": "+41791234567",
  "width": 1024,
  "height": 1024
}

// Response
{ "ok": true, "result": { "imageUrl": "https://...", "delivered": true } }
```

#### `analyze_image`

Send an image for vision analysis by a multimodal model.

```json
// Request params
{
  "imageBase64": "...",
  "mimetype": "image/jpeg",
  "prompt": "Describe what's in this image",
  "source": "whazaa",
  "recipient": "+41791234567"
}

// Response
{ "ok": true, "result": { "text": "The image shows...", "model": "claude-3-5-sonnet", "durationMs": 1200 } }
```

#### `analyze_video`

Send a video for analysis. Result is delivered to the active Claude Code session.

```json
// Request params
{
  "videoBase64": "...",
  "mimetype": "video/mp4",
  "prompt": "Describe this video",
  "source": "whazaa",
  "recipient": "+41791234567"
}

// Response
{ "ok": true, "result": { "text": "...", "model": "...", "durationMs": 2400, "path": "/tmp/..." } }
```

### PAI Project Integration

#### `pai_projects`

List PAI named projects available for launch.

```json
// Response
{
  "ok": true,
  "result": {
    "projects": [
      { "name": "AIBroker", "slug": "aibroker", "path": "/Users/me/dev/AIBroker" },
      { "name": "PAILot", "slug": "pailot", "path": "/Users/me/apps/PAILot" }
    ]
  }
}
```

#### `pai_find`

Find a PAI project by name.

```json
// Request params
{ "name": "aibroker" }

// Response
{ "ok": true, "result": { "path": "/Users/me/dev/AIBroker", "slug": "aibroker" } }
```

#### `pai_launch`

Launch a PAI project in a new iTerm2 tab running Claude Code.

```json
// Request params
{ "name": "AIBroker" }

// Response
{ "ok": true, "result": { "launched": true, "session": "Claude Tab" } }
```

### Session Orchestration

These handlers power cross-session coordination. See [sessions.md](./sessions.md) for the full workflow.

#### `session_content`

Read raw terminal output from one or all Claude Code sessions. The `changed` flag tells callers whether to re-parse or use the cached summary.

```json
// Request params — single session
{ "sessionId": "ABC123-DEF456", "lines": 100 }

// Request params — all sessions
{ "lines": 100 }

// Response (single session)
{
  "ok": true,
  "result": {
    "session": {
      "sessionId": "ABC123-DEF456",
      "name": "My Project",
      "content": "...last 100 lines of terminal output...",
      "atPrompt": false,
      "contentHash": "a1b2c3d4",
      "changed": true,
      "cachedSummary": null,
      "cachedAt": null
    }
  }
}

// Response (all sessions)
{
  "ok": true,
  "result": {
    "sessions": [
      {
        "sessionId": "ABC123",
        "content": "...",
        "atPrompt": true,
        "contentHash": "a1b2c3",
        "changed": false,
        "cachedSummary": "Session is idle at shell prompt.",
        "cachedAt": 1741420800000
      }
    ]
  }
}
```

#### `cache_status`

Store a parsed summary for a session. Called by the requesting AI after interpreting `session_content` output.

```json
// Request params
{
  "sessionId": "ABC123-DEF456",
  "sessionName": "My Project",
  "summary": "Claude is implementing the auth middleware. Running Bash (15s).",
  "contentHash": "a1b2c3d4",
  "state": "busy"
}

// Response
{ "ok": true, "result": { "cached": true, "sessionId": "ABC123-DEF456" } }
```

#### `get_cached_status`

Retrieve stored summaries without re-probing.

```json
// Request params — single session
{ "sessionId": "ABC123-DEF456" }

// Request params — all sessions
{}

// Response (single)
{
  "ok": true,
  "result": {
    "snapshot": {
      "sessionId": "ABC123-DEF456",
      "sessionName": "My Project",
      "timestamp": 1741420800000,
      "state": "busy",
      "summary": "Claude is implementing the auth middleware.",
      "contentHash": "a1b2c3d4",
      "lastProbeAt": 1741420800000
    }
  }
}

// Response (all sessions) — returns { "snapshots": [...] }
```

### AIBP Protocol

#### `aibp_register`

Register an MCP process as an AIBP plugin. Called once at MCP startup.

```json
// Request params
{
  "pluginId": "ABC123-DEF456",
  "sessionEnvId": "w0t0p0:ABC123-DEF456"
}

// Response
{
  "ok": true,
  "result": {
    "address": "mcp:ABC123-DEF456",
    "resolvedSession": "session:ABC123-DEF456"
  }
}
```

The `resolvedSession` is the AIBP channel the MCP has joined. The MCP caches this to avoid per-call TTY detection.

#### `aibp_send`

Send a message from one session to another through the AIBP routing fabric.

```json
// Request params
{
  "fromSession": "ABC123",
  "toSession": "DEF456",
  "content": "Your build is complete.",
  "type": "TEXT"
}

// Response
{ "ok": true, "result": {} }
```

#### `aibp_status`

Query the full state of the AIBP registry.

```json
// Response
{
  "ok": true,
  "result": {
    "plugins": [
      { "address": "mobile:pailot", "type": "mobile", "name": "PAILot" },
      { "address": "hub:session-handler", "type": "hub", "name": "Session Handler" },
      { "address": "mcp:ABC123", "type": "mcp", "name": "MCP (ABC123)", "sessionName": "My Project" }
    ],
    "channels": [
      { "name": "session:ABC123", "members": ["mobile:pailot", "hub:session-handler", "mcp:ABC123"], "outboxSize": 0 }
    ],
    "commands": [
      { "name": "/s", "owner": "hub:session-handler", "description": "List sessions" }
    ]
  }
}
```

### PAILot Messaging

#### `pailot_send`

Send text or voice to the PAILot mobile app via the WebSocket gateway.

```json
// Text message
{ "text": "Hello from Claude", "sessionId": "ABC123" }

// Voice note
{ "text": "Hello from Claude", "voice": true, "voiceName": "bm_fable", "sessionId": "ABC123" }

// Response (text)
{ "ok": true, "result": { "sent": true } }

// Response (voice, chunked)
{ "ok": true, "result": { "sent": true, "chunks": 2 } }
```

#### `pailot_receive`

Drain the PAILot message queue.

```json
// Response
{
  "ok": true,
  "result": {
    "messages": [
      { "timestamp": 1741420800000, "body": "What's the build status?" }
    ]
  }
}
```

### Routing

#### `command`

Execute a slash command through the hub command handler. The hub tries the first registered adapter's `command` handler.

```json
// Request params
{ "text": "/ss" }

// Response
{ "ok": true, "result": { "executed": true, "command": "/ss" } }
```

#### `route_message`

Send a `BrokerMessage` to the hub routing engine. Adapters use this to forward inbound messages for dispatch.

```json
// Request params
{
  "message": {
    "source": "whazaa",
    "type": "command",
    "payload": {
      "text": "/ss",
      "recipient": "+41791234567",
      "timestamp": 1741420800000
    }
  }
}

// Response
{ "ok": true, "result": { "routed": true } }
```

#### `broadcast_status`

Push a `StatusSnapshot` to the hub's `StatusCache` (used by adapters to report session state).

```json
// Request params
{
  "sessionId": "ABC123",
  "summary": "Claude is idle.",
  "state": "idle",
  "contentHash": "a1b2"
}
```

## IpcServer Implementation

Source: `src/ipc/server.ts`

```typescript
class IpcServer {
  on(method: string, handler: IpcHandler): void
  start(): void   // Creates socket, begins listening
  stop(): void    // Closes socket, deletes socket file
}

type IpcHandler = (req: IpcRequest) =>
  Promise<{ ok: true; result: Record<string, unknown> }
        | { ok: false; error: string }>;
```

Stale sockets from previous runs are cleaned up automatically at `start()`. The server logs errors but does not crash on client disconnect.

## Error Response Format

All errors follow the same shape:

```json
{ "id": "...", "ok": false, "error": "Human-readable error description" }
```

Common error strings:

| Error | Cause |
|-------|-------|
| `Unknown method: X` | No handler registered for method X |
| `Adapter 'X' not registered. Is the X daemon running?` | `adapter_call` with an unknown adapter |
| `AIBP bridge not initialized` | Hub hasn't started AIBP yet |
| `sessionId is required` | Missing required parameter |
| `Invalid BrokerMessage: source and type are required` | Malformed route_message payload |
