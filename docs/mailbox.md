# The session mailbox

A durable queue per session, so a message to a busy session is not lost.

`aibroker_send_to_session` does two things: it **types** the message into the
target's terminal, and it **deposits** it into that session's mailbox. The typed
copy is best-effort — a session mid-turn never reads it — and the mailbox is
what makes the message recoverable.

## Why it exists

The mailbox was pull-only at first: a message arrived only if the target session
happened to call `aibroker_receive`. It usually did not. On 2026-08-01/02,
**35 real messages sat undrained across five sessions**, the oldest for a day,
while every sender had been told `ok: true`.

That is the failure this system keeps producing in different costumes: something
reports success and delivers nothing. Two mechanisms fix it.

## Delivery is confirmed, not assumed

`submitAndConfirm()` watches the text leave the input line before reporting
success. Callers get one of two answers and must not conflate them:

| Result | Meaning |
|---|---|
| `delivered: true` | The target was observed taking it |
| `delivered: false, queued: true` | Typed but unconfirmed — the target is probably mid-task; it is in the mailbox |

**`ok: true` does not mean "they have seen it".** It means the hub took
responsibility for the message.

Retries default to **1** for live sessions. A redelivered message is a duplicate
nobody downstream can tell apart from two real events — the default of three once
delivered one message to a session three times.

## Draining

`hooks/drain-mailbox.mjs` runs as a `UserPromptSubmit` hook: it fires before the
model sees the turn, which is the first moment a busy session is listening
again. Anything queued is injected as context on the very next turn rather than
whenever someone thinks to check.

Two properties matter:

**Draining is destructive** — the daemon empties the mailbox as it reads it — so
the hook must not swallow what it cannot deliver. If the output cannot be
emitted, messages are written to `~/.aibroker/undelivered.jsonl` rather than
lost. That is the whole failure this hook exists to end, one level down.

**It is silent when there is nothing waiting, and silent on every error.** A hook
that fails loudly on every prompt is a hook somebody disables.

## Refusals

A message is refused before being deposited *or* typed if the target's terminal
is at a **shell prompt** rather than a live Claude prompt. A shell would
*execute* the text rather than read it. The refusal is audited with that reason,
because "the hub declined to type this into a shell" otherwise leaves no trace
anywhere.

## Limits

The mailbox holds **100** messages per session. A full mailbox used to drop its
oldest silently; eviction is now reported to the caller, since a silent drop is
the same fault at a smaller scale.

## Related

- [channels.md](./channels.md) — delivery modes and why `task` is often safer
- [audit.md](./audit.md) — every deposit, delivery and refusal is recorded
- [sessions.md](./sessions.md) — how a name resolves to a session
