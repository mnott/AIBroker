# Keeping a long autonomous session running

A pattern, and the failures that shaped it. An agent session given a standing
goal will eventually decide it is finished and stop. A watchdog notices and hands
it the next thing, so a run that would have lasted one context window lasts a
night.

Nothing here is exotic. What makes it work is a handful of decisions that all
look like details and are not.

## The shape

```
  watchdog (launchd)              session (a terminal)
        │                                 │
        │  1. notice it has stopped       │
        │  2. type ONE item as a goal ────▶
        │  3. confirm it submitted        │
        │                                 │  … works, commits
        │  ◀──── appends one line to the done file
        │  4. advance the queue           │
```

## One item per goal

The original failure: a goal listing ten items. One context window finishes some
of them, the judge says "not achieved", and the loop repeats — reading as failure
every cycle while the work went fine. **The goal was too big to ever be true.**

Send exactly one item. This single constraint is the remedy; everything else is
plumbing to notice when the session has run out of goal.

## Typing, not messaging

`send_to_session` prefixes every message with `[Session:<sender>] `. That is
right for conversation and fatal for a command: a slash command is only a command
at the start of a line, so a prefixed `/goal …` arrives as literal text and does
nothing at all — silently.

So the watchdog types into the terminal. That also means it needs no screen
control: no pointer moves, no window is raised, and a locked screen does not stop
it. Driving the mouse for this would seize a machine somebody else is using, for
hours, unattended.

**Typed is not sent.** Writing text into a terminal leaves it sitting in the
input box. The sequence that submits, in order:

| step | why |
|---|---|
| `ASCII 105` (`i`) | the editor may be in vi normal mode, where the text would be commands |
| `ASCII 127` (backspace) | removes that `i` if it was already in insert mode |
| the text, `newline no` | deliberately without a trailing newline |
| `ASCII 13` | the actual Return |

Then **confirm the effect, not the attempt**: read the session back and require
it to have changed before recording success. A first version logged "re-armed"
for a goal that sat unsubmitted until a human pressed Return — the watcher
committing the failure it existed to prevent. If a retry is needed, retry the
*submit*, never the payload: retyping leaves two copies.

## Detecting that it stopped

Three instruments, in order of trust.

**Activity, from the transcript on disk.** Claude Code appends to
`~/.claude/projects/<slug>/*.jsonl`. Its mtime moves when the session genuinely
writes. A `stat` costs nothing, so this can be polled often.

**The goal marker, from the pane.** The status line shows `/goal active` while a
goal is armed; its absence is what "the goal ran out" looks like from outside.

**Do not use a busy flag you have not checked.** The hub's `atPrompt` reads
`false` for every session of this kind, working or stopped, because the
foreground process is always the same binary. A flag that never varies cannot
detect anything, and trusting it is why a stopped session went unnoticed for
twelve minutes.

Require *both* quiet and no-goal before re-arming. Quiet alone interrupts a
session that is thinking; a missing goal marker alone can catch a gap between
turns.

## Expensive checks only when the cheap one fires

Reading a terminal pane runs AppleScript and blocks the hub's single thread for
about a second. Polling that every few seconds starves everything else — on this
machine it once left other adapters' heartbeats timing out and their connections
dropping, which then produced more reconnects and more polling.

Poll the cheap signal (a file mtime) often; read the pane only once the cheap
signal says something is idle.

## Context rollover

A session near its context limit must be carried across the boundary rather than
left to hit it. Ask it to write a continuation prompt, clear, and re-arm from
that text.

Two rules, both learned the hard way:

**Ask for a file, not for text on screen.** A four-thousand-character handoff
wraps, scrolls, and cannot be reassembled from a screen-scrape. The session wrote
it perfectly and the watcher never saw it. A file is exact and free to read.

**Never clear before the handoff is in hand.** `/clear` is irreversible. Read the
file back, require it to be substantial, and only then clear. A missed rollover
costs one interruption; a blind clear costs everything the session knew.

## The goal has a length ceiling

A goal beyond roughly 4000 characters is refused outright, and a refused goal
leaves the session with nothing. So the context lives in a file and the goal
points at it:

```
/goal Read <handoff file> first — it is your full context.
      Then do exactly ONE thing: <item>. <standing rules>
```

Short goal, deep context — the inverse of the arrangement that caused the
original problem.

## Let the session advance the queue

The queue pointer must not move only when the *watchdog* sends something. A
session reading the same handoff file will quite reasonably work ahead, and then
the pointer is stale and the next send is work already finished.

Have the session append one line per finished item to a done file, and advance on
that. It is the same act as finishing rather than a second act it might forget.

## Say something while idle

A watcher that is silent when healthy cannot be told from one that has died. Log
a heartbeat every few minutes with what it can see — goal armed, how quiet, how
much context is left, what is next. Report cycle events to whatever channel the
operator actually watches, with a timestamp: the useful question about an
unattended loop is nearly always *when*, not *whether*.

## Never run out of queue

When the list is finished the objective has not changed. Fall back to a standing
item asking the session to choose the next gap itself. A watcher whose last act
is to go quiet has not kept anything running.

## Do not fight the operator for the input line

Stop the watchdog before arming a session by hand. Otherwise a scheduled re-arm
overwrites what was just typed, and the session ends up on the wrong item with no
sign of why.

## Reference implementation

`~/.aibroker/*-watchdog.mjs`, run by a launchd agent with `KeepAlive`, writing to
`/tmp/*-watchdog.log` with state in `~/.aibroker/*-watchdog-state.json`. It talks
to the hub over `/tmp/aibroker.sock` — `sessions`, `session_content` and
`pailot_send` are all it needs.
