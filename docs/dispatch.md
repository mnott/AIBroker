# Dispatch work to a project's session

```bash
aibroker dispatch <project> --stdin --json [--no-spawn]
```

Resolves a project to its running Claude session and delivers a message, launching the session if none is running. One atomic call: a caller doing list → launch → send itself races, because a session can start or die between the check and the send.

The body comes in over **stdin** — task bodies are multi-line and carry quotes and backticks, which argv mangles. Messages arrive prefixed `[Task]`, meaning *act on it, do not reply* (unlike `[Session:NAME]`, there is no sender left to reply to).

Outcomes are results, not errors — all exit 0, so a batch keeps going:

| outcome | meaning |
|---|---|
| `delivered` | a live session accepted it |
| `spawned` | none was running; one was launched and accepted it |
| `unlaunchable` | no curated alias — run `pai project name <identifier> <shortname>` |
| `unreachable` | tab opened but the session never accepted input |
| `skipped` | no live session and `--no-spawn` was set |

Resolution uses the **curated** alias list only, never `pai project names --all`: the full set has no aliases and real ambiguity (several registry rows share a display name at different paths), so widening it dispatches work to the wrong directory silently. Bus participation is opt-in by design.

`spawned` means *confirmed submitted*, not *tab opened* — delivery is verified by watching the message leave the input box and land in the transcript, which works whether the session is idle or busy.

`--timeout SECONDS` is a **total budget for the whole dispatch**, not a per-stage cap: the readiness wait and the delivery share it, retries included. Callers that wrap this in their own kill timer should set it below theirs — then AIBroker always times out first and returns a reason, instead of being killed and surfacing as the caller's own timeout with the cause lost.

The logic lives in the daemon (`dispatch` IPC), so MCP, PAILot and adapters can route work without shelling out; the CLI is a thin, versioned wrapper for shell callers.

## Ask a session whether it is still alive

```bash
aibroker ask <project> --stdin --timeout 60 --json
```

For callers with no session and no mailbox — a launchd poller checking whether the session it handed work to is still going. **Never spawns**: a probe that creates the thing it is probing turns a dead session into a fresh one and reports health.

| state | meaning |
|---|---|
| `replied` | it answered; `reply` holds its words |
| `busy` | mid-turn and still producing output. **Alive** — nothing was sent |
| `silent` | idle, took the question, never answered. Genuinely suspicious |
| `absent` | no live session for that project |

**`busy` is positive evidence of life and must not count toward a stuck threshold.** Claude Code queues typed input while mid-turn and only reads it when the turn ends, so a session busy doing exactly the work it was given cannot answer — and a short timeout would report it as silent. Since a scheduler probes precisely when a task has overrun, that false positive would fire constantly. Liveness is therefore decided *before* any question is sent, which also means a working session pays no token cost for being probed.

Every probe of an idle session does inject a message that stays in that session's context, so keep the text short and probe rarely.
