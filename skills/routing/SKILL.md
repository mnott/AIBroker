---
name: routing
description: >
  Full AIBroker channel routing, Task handling, session orchestration and mailbox rules.
  USE WHEN a message arrives with a [Whazaa], [Telex], [PAILot], [Session:...], [Task] or other channel prefix, or before replying through any aibroker/whatsapp/telegram/pailot tool.
---

## AIBroker — Unified Message Bridge for Claude Code

### Routing (per message, never violate)
- No prefix = terminal. Terminal-only reply. Never call a send/tts tool.
- Prefixed = channel. Reply via the tool for that prefix below.
- `:voice` in the prefix = reply with the matching `_tts` tool, NEVER `_send`.

| Prefix | Source | Reply with |
|---|---|---|
| `[Whazaa]` | WhatsApp text | `whatsapp_send` |
| `[Whazaa:voice]` | WhatsApp voice | `whatsapp_tts` |
| `[Telex]` | Telegram text | `telegram_send` |
| `[Telex:voice]` | Telegram voice | `telegram_tts` |
| `[PAILot]` | PAILot text | `pailot_send` |
| `[PAILot:voice]` | PAILot voice | `pailot_tts` |
| `[Session:NAME]` | another Claude session | `aibroker_send_to_session` |
| `[Broadcast:NAME]` | a shout to all sessions | answer with `aibroker_broadcast_reply` only when it asks (reply id is in the message), otherwise read and carry on — never block on it |
| `[Keepalive]` | cache beat | no reply, no tools, answer with at most one word |
| `[Task]` | task-bus work order | act, see Task rules below |
| `[Task:comment]` | follow-up on a Task | act, see Task rules below |
| _none_ | terminal | terminal only |

### Task / Task:comment
- Act on it. Answer questions with `todoist_reply` using the id from the `[todoist:<taskId> in:<projectId>]` trailer — the asker is on a phone.
- File follow-ups into that same `in:` project. Never create a project named after your alias — a human-readable one already exists (`todoist_ingress` action `resolve`).
- Leave the task open; the asker closes it.
- `[Task]` is a work order, not a question — the sender has exited, no reply channel. Close it (`pai task done <id>`) when done; if blocked or you disagree, file back with `pai task add`. The task body wins on conflict.
- `[Task:comment]` is a correction to work in flight, not a new order — adjust, don't restart. Same trailer, same reply route.
- A task filed into an ingress project fires `item:added` and comes back to you as a new order — use `todoist_task`, marked so that echo drops. Scheduling your own future work is fine (`reminder:fired` still delivers). Raw Todoist tools only for projects that reach nobody else.

### Rules
- Never open a blocking interactive prompt for a channel message (`[Task]`, `[Task:comment]`, `[PAILot]`, `[Whazaa]`, `[Telex]`, `[Session:…]`) — the sender can't answer, and the session would freeze. Decide it yourself if routine, say what you chose; else ask ON the source channel (`todoist_reply`, `pailot_send`, `whatsapp_send`, …) and stop.
- Strip the prefix before processing.
- Match the medium: text in → text out, voice in → voice out.
- Same content the terminal would get — don't shorten or paraphrase.
- **bold**/*italic* only in `whatsapp_send`/`telegram_send`; no headers or code blocks there.
- No markdown/asterisks in `_tts` calls — TTS reads them literally.
- If a prefixed task takes more than a few seconds, send a brief ack first via the matching `_tts`/`_send` tool. Never leave the client silent.
- `[Session:NAME]`: reply via `aibroker_send_to_session(target=NAME, message=YOUR_RESPONSE)`, not the terminal (a Claude Code peer marked native in `aibroker_sessions` can be reached with SendMessage using its Claude name; on SendMessage error use aibroker_send_to_session) — the sender waits on `aibroker_receive`. Don't add a `[Session:...]` prefix yourself; the hub does.
- Routing switches per message automatically, no manual toggle.
- Only the operator's own channels (Telex, Whazaa, PAILot) are typed into your input line. Machine ingress (Todoist, forge/GitHub events, worker alerts, other sessions) is stored in your mailbox and nothing is typed. Run `aibroker mailbox wait --follow` under the Monitor tool with the maximum timeout — each new message prints one line as a notification, so there is no restart per message; re-arm it when the monitor expires (fallback for harnesses without Monitor: keep exactly ONE plain `aibroker mailbox wait` in the background via `run_in_background` and re-start it after every exit). When a notification arrives, read the mailbox (`aibroker_receive`) and act.

### Companion app tagging
Outgoing text is prefixed with U+FEFF (invisible in WhatsApp) so companion apps can tell PAI from the user; Baileys message IDs start with `3EB0`, user phone IDs never do.

### Session orchestration
Check other running Claude sessions without switching to them.
1. `aibroker_session_content()` — no args = all, or `sessionId` for one. Returns raw output, `atPrompt` (idle), `changed` (since last check).
2. If `changed`, summarize in 1-2 sentences, cache with `aibroker_cache_status({ sessionId, summary, contentHash, state })`. Else reuse `cachedSummary` from the response.
3. `aibroker_get_cached_status()` returns all cached summaries instantly.

State: `atPrompt: true` → `idle`, `atPrompt: false` → `busy`. Present as a compact table (session, state, summary); read as a sentence for voice.
