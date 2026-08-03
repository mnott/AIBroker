# The audit trail

`~/.aibroker/audit.jsonl`

Every cross-session and cross-channel action is recorded: what happened, who
caused it, what it touched, and — this is the part that matters — **what was
refused and why**.

The trail exists because this system's characteristic failure is silence. A
message typed into a session that never read it, a webhook rejected for a bad
signature, a task dropped because its project was not granted: each of these
looks exactly like nothing having happened. The first question when a channel
appears broken is always *did anything arrive at all*, and only the audit trail
can answer it.

```bash
aibroker audit                        # recent events
aibroker audit --action inbound       # one action kind
aibroker audit --session Home         # one session, either end
aibroker audit --since 2026-08-03     # from a date
aibroker audit --trace <id>           # follow one chain across hops
aibroker audit --bodies               # include message bodies
aibroker audit --json                 # machine-readable
```

## What a record contains

| Field | Meaning |
|---|---|
| `id` | Stable id, namespaced per producer |
| `ts` | When |
| `action` | `webhook`, `inbound`, `dispatch`, `refuse`, `ingress`, `todoist-task`, `todoist-mirror`, `todoist-oauth`, `inbound-route`, … |
| `actor` | Who caused it — `session:Home`, `hook:monster`, `todoist`, `external` |
| `target` | What it touched — `session:AIBroker`, `todoist:project:…`, `hook:mail` |
| `outcome` | `delivered`, `queued`, `refused`, `ignored`, `granted`, `revoked`, … |
| `reason` | Why, in words. Mandatory in spirit for every refusal. |
| `body` | The message, when `--bodies` is asked for |

## Rules the trail is built on

**Refusals are recorded, not just successes.** An endpoint that silently 404s a
probe teaches you nothing; the interesting fact about a probe is that it
happened. `aibroker audit --action inbound` separates "the sender never called"
from "we rejected it" in one line — which on 2026-08-03 was the difference
between a broken Apps Script and a broken endpoint, and settled it instantly.

**Actors are namespaced.** Bare session names collide once more than one
producer writes to the trail, so entries read `session:Home`, not `Home`.

**Multi-writer safe.** Several sessions and the daemon append concurrently.
Records are appended atomically; a partially written line is never produced.

**Nothing is rewritten.** A published version and a pushed commit are facts. When
0.22.0 shipped another session's in-flight work, the response was a follow-up
record — not an edited history. An audit trail edited to look tidy is not one.

## Reading a chain

`noteInbound()` links an inbound event to whatever it caused, so a single id can
be followed from arrival to effect:

```bash
aibroker audit --trace ab-msd9u5ze-208feq
```

That matters where one event fans out — a Todoist task that dispatched to a
session, which replied, which mirrored the reply. Without the chain you have
four unrelated lines and a guess.

## When you will actually want it

- **A channel looks dead.** Did anything arrive? Was it refused, and for what?
- **Something ran twice.** Two `delivered` records with different ids means two
  real events; the same id twice means a retry that should not have happened.
- **Someone else's session touched your project.** `--session` shows both ends.
- **A grant appeared or vanished.** Ingress grants and route creation are
  recorded, so "who allowed this" has an answer.

See [channels.md](./channels.md) for why each refusal exists in the first place.
