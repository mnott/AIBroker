# Commands

All slash commands are handled by `createHubCommandHandler()` in `src/daemon/commands.ts`. The handler is transport-agnostic: it receives a `CommandContext` with `reply()`, `replyImage()`, and `replyVoice()` methods wired to the originating adapter. The same code runs whether the command came from WhatsApp, Telegram, or PAILot.

## Command Reference

### Session Management

#### `/s` — List Sessions

Lists all sessions in the `HybridSessionManager`, pruning dead visual sessions first.

```
/s

 1. My Project [api] (/Users/me/project)
*2. Claude Tab [visual] (/Users/me/project)   ← active
 3. Other Work [visual] (/Users/me/other)
```

The `*` marks the active session. `[api]` = headless Claude subprocess, `[visual]` = iTerm2 tab.

Alias: `/sessions`

#### `/N` — Switch to Session N

Switches the active session to session number N (1-based).

```
/2
→ "Switched to *Claude Tab* [visual]"
```

Optionally rename in one step:

```
/2 Backend API
→ "Switched to *Backend API* [visual]"
```

The underlying iTerm2 tab is brought to focus for visual sessions. `APIBackend.activeSessionId` is updated for API sessions.

#### `/n <path>` — New Visual Session

Creates a new iTerm2 tab running Claude Code at the specified path.

```
/n ~/dev/myproject
→ "New visual session: *myproject* (~/dev/myproject)"
```

The new tab opens with `claude --dangerously-skip-permissions` in the target directory. The session becomes active immediately.

Aliases: `/nv`, `/new`, `/relocate`

#### `/nh <path>` — New Headless Session

Creates a new API (headless) session backed by a Claude subprocess. No iTerm2 tab is created.

```
/nh ~/dev/myproject
→ "New headless session: *myproject* (~/dev/myproject)"
```

Headless sessions respond to text messages directly through the Claude Agent SDK. No visual terminal is involved.

#### `/r N` — Restart Claude in Session N

Restarts Claude Code in iTerm2 session N by killing and re-creating the Claude process.

```
/r 2
→ "Restarting session 2…"
```

Only valid for visual sessions. Terminal-type sessions are rejected ("Use /e to end terminal sessions.").

Alias: `/restart N`

#### `/e N` — End Session N

Closes session N. For visual sessions, kills the iTerm2 tab. For API sessions, terminates the subprocess.

```
/e 3
→ "Ended session *Other Work*."
```

The session is removed from the HybridSessionManager and all registry entries pointing to it are cleaned up. The active index adjusts automatically.

Alias: `/end N`

#### `/t [command]` — Open Terminal Tab

Opens a raw terminal tab in iTerm2, optionally running a command.

```
/t
→ Opens a new terminal tab

/t ssh me@myserver
→ Opens a new tab running ssh me@myserver
```

The tab is tracked as a managed session but not registered in `HybridSessionManager`.

Aliases: `/terminal [command]`

---

### Session Control

#### `/ss` — Screenshot / Session Status

For **visual sessions**: Takes a screenshot of the active iTerm2 window and sends it as an image.

For **API sessions**: Returns the text status from `APIBackend.formatStatus()` (no screenshot needed since there is no visual interface).

```
/ss
→ [image of active iTerm2 window]
  — or —
→ "Session: my-project | State: thinking | Tool: Bash (12s) | Turns: 5"
```

Alias: `/screenshot`

#### `/st` — Session Status Overview

Lists all iTerm2 sessions with their status. Uses `snapshotAllSessions()` to read live iTerm2 state and merges with cached `StatusSnapshot` entries from `StatusCache`.

```
/st

*Session Status*

1. 🟢 *My Project* — idle
2. 🔴 *Backend API* — busy  ← active
   _Implementing the auth middleware_
3. 🟡 *Other Work* — working
```

Status icons:
- 🟢 Idle — iTerm2 is at the prompt
- 🔴 Busy — StatusCache shows non-idle state AND iTerm2 is not at prompt
- 🟡 Working — iTerm2 is not at the prompt (no cached state)

Cached summaries older than 5 minutes are not displayed.

Alias: `/status`

#### `/c` — Clear Active Session

For **visual sessions**: Sends `/clear` to the active iTerm2 session (after a 10-second delay to let Claude finish), then sends `go` to resume.

For **API sessions**: Calls `HybridSessionManager.clearActiveSession()` which calls `APIBackend.clearSession()` to reset the conversation history.

```
/c
→ "Clearing in ~10s…"
→ [10s delay]
→ "Sent /clear + go"
```

#### `/p` — Pause Session

Sends the text `pause session` to the active iTerm2 session. Claude Code responds by saving its state and exiting gracefully.

```
/p
→ "Sent \"pause session\""
```

---

### Keyboard Control

These commands send keystrokes directly to the active iTerm2 session via AppleScript. They are valid only for visual sessions.

#### `/cc` — Ctrl+C

Sends ASCII character 3 (ETX / Ctrl+C). Interrupts running processes.

```
/cc
→ "Ctrl+C sent"
```

#### `/esc` — Escape

Sends ASCII character 27 (ESC).

```
/esc
→ "Esc sent"
```

#### `/enter` — Return Key

Sends ASCII character 13 (CR / Return).

```
/enter
→ "Enter sent"
```

#### `/tab` — Tab Key

Sends ASCII character 9 (HT / Tab). Triggers shell completion.

```
/tab
→ "Tab sent"
```

#### Arrow Keys

Send ANSI escape sequences for cursor movement.

| Command | Sequence | Description |
|---------|----------|-------------|
| `/up` | ESC[A | Move cursor up / previous history |
| `/down` | ESC[B | Move cursor down / next history |
| `/left` | ESC[D | Move cursor left |
| `/right` | ESC[C | Move cursor right |

#### `/pick N [text]` — Select Menu Option

Selects option N from a numbered menu by pressing the Down arrow N-1 times, then Enter. If `text` is provided, it is typed after the selection.

```
/pick 3
→ Presses Down×2, then Enter

/pick 2 my answer
→ Presses Down×1, Enter, then types "my answer"
```

The arrows are sent with 50ms delays between each press. The optional text is typed 200ms after Enter.

---

### Media

#### `/image <prompt>` — Generate Image

Generates an image using the Replicate Flux model and sends it as a reply.

```
/image a cyberpunk cat in Tokyo at night
→ "On it... generating your image."
→ [image]
```

Alias: `/img <prompt>`

#### Natural Language Image Detection

The command handler also detects natural language image requests in plain text (no slash prefix needed):

English pattern: `send/show/give/create/make/draw/paint/render/generate [me] [an/a] image/picture/photo/illustration of ...`

German pattern: `schick/zeig/mach/erstell/generier/mal [mir] [ein/eine] bild/foto/zeichnung/illustration von ...`

```
send me a picture of a sunset
→ [same as /image a sunset]

zeig mir ein Bild von einem Sonnenuntergang
→ [same as /image a Sonnenuntergang]
```

---

### Meta

#### `/h` — Help

Sends the command reference as a formatted text reply.

```
/h

*Commands*

*Sessions*
/s — List sessions
/N — Switch to session N
...
```

Alias: `/help`

#### `/restart` — Restart Adapter

Signals the originating adapter to restart itself. The hub cannot restart adapters directly — this is forwarded back to the adapter's own restart logic.

```
/restart
→ "Restart command — handled by adapter."
```

---

## Plain Text Delivery

Any message that is not recognized as a slash command is delivered directly to the active Claude Code session.

### Delivery Path

```
text → command handler → deliverMessage()
```

The delivery process:
1. Check if a managed iTerm2 session is available
2. Try `typeIntoSession(activeItermSessionId, text)` via AppleScript
3. If screen is locked, fall back to PTY write via `/dev/tty`
4. If no active session, search for any running Claude session
5. If none found, create a new Claude session

### Source Tagging

Messages are prefixed with a source tag so Claude knows which transport sent them:

| Source | Prefix |
|--------|--------|
| `pailot` | `[PAILot] message` |
| `telex` | `[Telex] message` |
| `whazaa` | `[Whazaa] message` |

Voice transcripts use `[PAILot:voice] transcript`.

Special cases:
- Messages starting with `!` have the `!` stripped and are delivered untagged
- Messages starting with `/` are delivered unmodified (passthrough slash commands)

### API Session Delivery

When the active session is an API session (`kind === "api"`), the message goes to the Claude Agent SDK directly instead of iTerm2:

```typescript
deliverViaApi(apiBackend, textToDeliver, backendSessionId, {
  sendText: (reply) => ctx.reply(reply),
  sendVoice: (buffer, transcript) => ctx.replyVoice(buffer, transcript ?? ""),
});
```

The SDK handles the conversation turn and delivers the response back through the `CommandContext`.

---

## Adding a New Command

1. Add a match check in `handleMessage()` in `src/daemon/commands.ts`
2. Use `ctx.reply()`, `ctx.replyImage()`, or `ctx.replyVoice()` — never call adapter-specific functions
3. Add the command to the `/h` help text
4. If the command needs keyboard access, check `hybridManager?.activeSession?.kind` and reject API sessions with a clear message

Pattern:

```typescript
// Match /mycommand [arg]
const myMatch = trimmedText.match(/^\/mycommand(?:\s+(.+))?$/);
if (myMatch) {
  const arg = myMatch[1]?.trim() ?? null;
  // ... do work ...
  ctx.reply(`Done: ${arg ?? "(no arg)"}`).catch(() => {});
  return;
}
```

Always `return` after handling a command to prevent fall-through to the plain text delivery path.

---

## CommandContext

Source: `src/daemon/command-context.ts`

The interface passed to the command handler on every message:

```typescript
interface CommandContext {
  reply(text: string): Promise<void>;
  replyImage(imageBuffer: Buffer, caption: string): Promise<void>;
  replyVoice(audioBuffer: Buffer, caption: string): Promise<void>;
  source: string;      // "pailot" | "telex" | "whazaa" | "hub"
  recipient?: string;  // Optional target for direct message replies
}
```

The command handler calls these methods without knowing which transport is involved. The caller (PAILot gateway, IPC handler, adapter dispatch) wires the implementations at call time.

For PAILot, the methods route through AIBP:
```typescript
reply: async (text) => aibpBridge.routeToMobile(sessionId, text),
replyImage: async (buf, caption) => aibpBridge.routeToMobile(sessionId, caption, "IMAGE", {...}),
replyVoice: async (audio, caption) => aibpBridge.routeToMobile(sessionId, caption, "VOICE", {...}),
```

For WhatsApp/Telegram adapters, the methods call the respective adapter's send function via the IPC `deliver` call.
