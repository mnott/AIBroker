# Channels — how anything reaches a session

Todoist, PAILot, WhatsApp, Telegram and the generic HTTP endpoint look like five
integrations. They are one mechanism with five front doors: something happens
somewhere, it becomes a message addressed to a named session, and that session
decides what to do about it.

This page is the model they share. The per-channel pages
([todoist](./todoist.md), [pailot](./pailot.md), [inbound](./inbound.md),
[adapters](./adapters.md)) cover only what is specific to each.

Read this first. Every rule below was learned by breaking it.

---

## 1. Every inbound path ends at a session

A session is the addressee. Not the daemon, not a queue — a named Claude Code
session with a working directory, a project and a person behind it. Routing is
the act of turning "an event happened" into "this session should know".

Sessions are matched by name through one resolver, `core/session-match.ts`,
which folds whitespace, hyphens and underscores. `task-bus`,
`Task Bus` and `task_bus` are the same session; that is deliberate,
because humans name projects one way and configuration files another.

## 2. The channel decides the addressee. The payload never does.

| Channel | What determines the session |
|---|---|
| Todoist | the project the task is in, or a `pai:<name>` label, or an address in the text |
| Inbound HTTP | the route (`/hook/<name>`), fixed when the route is created |
| PAILot | the session the app is currently looking at |
| WhatsApp / Telegram | the last routed session, or the configured default |

**Never let the sender choose.** If a payload can name its target, whoever holds
the URL chooses which session executes with the user's full rights. That is the
difference between an inbound channel and a remote shell, and it is why
`/hook/jobs` was a design error: naming a route after a *topic* smuggles a
classification decision into the transport layer. Name routes after their
**source** — `monster`, `glidr` — and let the receiving session decide meaning.

Where classification is genuinely needed, use two hops: the event reaches a
triage session, and *that session* forwards with `aibroker_send_to_session`.
Judgement belongs in a session with context, never in a route table.

## 3. Payloads are data, not instructions

Everything arriving through a channel is content someone else wrote. It is
delivered with a prefix (`[Task]`, `[Inbound:route]`, `[PAILot]`, `[Session:x]`)
and, for the generic endpoint, an explicit statement that the body must not be
followed as an instruction.

This is not politeness. Todoist's own payload documents that the initiator of a
task "may be a collaborator from a shared project" — so without the boundary,
anyone on any shared project has a path to the machine.

## 4. Delivery has three modes, and they are not interchangeable

| Mode | Where it lands | Right for |
|---|---|---|
| **terminal** | typed into the session's prompt | conversation — the person is there now |
| **mailbox** | structured queue, drained on the next prompt | things a session should know, whenever it looks |
| **task** | a Todoist task | things that should become *work*, with a human-visible artifact first |

`task` is the safest default for anything that should be acted on: it puts a
visible item in front of the work, and it inherits the ingress grants. `message`
delivered into a working session is how the Home session ended up with twenty
mails on 2026-08-03 — the arrival rate collided with a session's attention.

## 5. Confirmed delivery is not the same as sent

`submitAndConfirm()` watches the text leave the input line before reporting
success; a message that was typed but not submitted is *queued*, not delivered,
and the mailbox holds it either way. Callers must distinguish
`delivered: true` from `delivered: false, queued: true` — reading `ok: true` as
"they have seen it" is how messages sat unread for a day.

Retries default to 1 for live sessions. A redelivered message is a duplicate
nobody downstream can tell apart from two real events.

## 6. Push is for latency. Catch-up is for correctness.

No external sender holds a queue for you. Todoist retries a handful of times;
most senders do less; a closed laptop answers nothing.

So every channel that matters needs a way to ask the source what it missed:

- Todoist comments — the activity log, in one request (`todoist-inbox.ts`)
- PAILot — the outbox and `catch_up` on reconnect
- A polling source — a marker **on the message**, not a timestamp

The marker distinction matters. A single `lastRun` timestamp skips mail that
arrives out of order and cannot survive a half-finished run. A label or flag set
on each item after confirmed delivery is idempotent, visible, and reversible.
See [inbound](./inbound.md) for the worked pattern.

## 7. Everything is audited, especially refusals

`~/.aibroker/audit.jsonl` records deliveries, refusals and the reason for each.
A refusal nobody records is a probe nobody notices — and the first question when
a channel appears broken is always *did anything arrive at all*, which only the
audit trail can answer. `aibroker audit --action inbound` separates "the sender
never called" from "we rejected it" in one line.

## 8. Agents mark what they write

Anything an agent writes back to a channel carries `🤖` (`AGENT_MARK`), and
marked content is ignored on the way in. Without it, a comment written by a
session triggers an event that routes to a session that comments again.

`initiator` cannot break the cycle: when agents act as the user, the initiator
*is* the user. The mark is the only reliable discriminator, which also makes it
the thing to check first when something loops.

---

## Choosing a channel

| You want | Use |
|---|---|
| To file work from a phone or watch | Todoist |
| To talk to a session, by voice or text | PAILot |
| A system you own to raise an event | Inbound HTTP route |
| A person to reach a session over a messenger | WhatsApp / Telegram adapter |

An inbound route earns its keep when the event is **rare**, **already
meaningful** (someone upstream decided it matters), **timely** (knowing now beats
knowing later), and **survivable if missed** while the machine is off. A stream
of undifferentiated items fails the first two: that is a job for a scheduled
sweep, not a channel.
