# Voice control

Two layers: the global TTS config (`voice-config.json`) and per-session voice settings (`voice-sessions.json`). A session can decide how it wants to be answered without changing anyone else's defaults.

## Per-session settings

Keyed by session name (resolved from the caller's pane, or an explicit `session` param). Each session has:

- `replyInVoice` — answer this session's prompts by voice until further notice
- `speed` — speech rate 0.5–2, rounded to 0.05
- `voice` — speaker override for this session

The `UserPromptSubmit` hook `hooks/voice-reply.mjs` reads the setting every prompt and, when `replyInVoice` is true, injects a short reminder to answer via `aibroker_speak`. Prompts delivered through another channel (`[PAILot`, `[Whazaa`, `[Telex`) get no reminder — they already have their own reply path.

## Natural-language mapping

When the user says something like this, call `aibroker_voice_config`:

| User says | Tool call |
| --- | --- |
| "reply in voice until further notice" | `{action:"set", replyInVoice:true}` |
| "back to text" / "stop replying in voice" | `{action:"set", replyInVoice:false}` |
| "slower" | `{action:"set", speedDelta:-0.1}` |
| "faster" | `{action:"set", speedDelta:+0.1}` |
| "other speaker" / "use voice X" | `{action:"set", voice:"X"}` — list speakers with `aibroker_list_voices` |
| "repeat" | `aibroker_repeat_speech` |
| "stop" | `aibroker_stop_speech` |

Omit `session` (or pass `"self"`) to scope to the caller's own session; pass a session name to target another. Global fields (`defaultVoice`, `voiceMode`, `localMode`, `personas`) only apply when no session scope is given.

## Precedence

When speaking: explicit `voice`/`speed` param > session setting > global default. `aibroker_speak` queues on the playback queue and returns immediately (`{speaking:true, queued:n}`); it does not block on synthesis. `speak_stop` stops playback and clears the queue; `speak_repeat` replays the last thing spoken to that session.
