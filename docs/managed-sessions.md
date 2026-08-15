# Managed sessions

Keep a session working on a standing objective. A session driven by a goal
decides at the end of each cycle whether the goal was met and then stops; left
alone it stops for the night, re-armed it works for as long as you let it. Two
nights of running this by hand produced sixteen hours of unattended work.

## The two ways in

```
aibroker manage [session] [objective | question | off | pause | resume | now | help]
```

From any shell. The session may be omitted when run inside one — naming a
session is how you reach a *different* one, which is the case that matters,
because a busy session cannot answer for itself. **This channel always works.**

```
/btw aibroker manage status
/btw aibroker manage what is going on?
/btw aibroker manage keep to the tests until I am back
```

From inside the session. `/btw` injects into a running turn instead of queueing
behind it, which is the only in-terminal form that survives a busy session.

`/btw manage …` works too, but prefer the namespaced spelling. "Manage" is an
ordinary English word — `/btw manage the risk of breaking X` is something you
might genuinely mean for the model — and because the hook BLOCKS whatever it
matches, a false positive means the model never sees what you said. Naming whose
manager you mean makes the interception deliberate rather than incidental.

## What it does

- `<objective>` — start managing; once running, an instruction carried into the
  next arming rather than interrupting the current one
- `status` — what the session looks like right now, and what the manager has done
- `now` — arm immediately, whatever the signals say
- `pause` / `resume` — stop arming without forgetting the objective
- `off` — stop
- `help` — the grammar, printed by the daemon that implements it, so the CLI,
  the hook and the tool cannot drift into three different lists

The manager re-arms `/goal <objective>` when the goal lapses. It does not
replace the goal mechanism, it drives it — so the session's own enforcement
still applies. Nothing is spawned: a manager is a record in the daemon, and
several sessions can be managed at once with no coordination between them.

## How this broke

Read this first if you are changing it. Every constant and every channel here
exists because of something below.

**The input line cannot carry a control channel.** The terminal owns it: while
a turn runs it queues what you type, and it rejects slash commands it does not
recognise — both *before* any hook is consulted. A `/manage` command therefore
fails in the exact condition it was built for. This was asserted confidently,
then disproved by a screenshot of it sitting in a queue.

**A `/btw` injection reaches a model with no tools.** The design that had the
hook pass unclassifiable phrasing to the model, for the model to interpret and
call a tool, cannot work: every `/btw` response reports having no tools loaded.
Interpretation is not free after all. Classification has to happen in the hook.

**Intent by keyword list fails on the first phrasing nobody imagined.** `status`,
`state`, `show` did not match "what's going on". The list was widened once and
would have failed again. Questions are now recognised by FORM — a trailing
question mark, or an opening interrogative — which is a property of the sentence
rather than a guess about vocabulary.

**The answer cannot be rendered inline while a turn runs.** Blocking the prompt
suppresses the injection and the reason never reaches the screen, so the reply
also goes to a notification, which nothing can swallow.

**The goal marker is scraped off a status line and it lies.** It read "active"
for ninety minutes after a session had finished, committed six times and gone
idle. It is used only alongside an age ceiling, never on its own.

**Completion is not always signalled.** An item that legitimately closes nothing
writes no done line, and a loop whose only completion signal is that line waits
forever while every heartbeat reads healthy. Hence the ceiling.

**"Typed" is not "sent" and "sent" is not "received."** A goal once sat
unsubmitted in an input box while the loop logged a successful re-arm. Arming is
confirmed by finding the objective's own words in the transcript — not by the
content hash changing, which cannot tell a delivered goal from stranded text.

**Two writers, one input line.** A manager and a person typing into the same
session will overwrite each other. Stop the manager before arming by hand.

**A hook that has never been observed firing has not been shown to fire.**
`/tmp/manage-hook.log` records every invocation, because "the hook did not run"
and "the hook ran and did nothing" look identical from the terminal, and telling
them apart by reasoning is how an evening goes on the wrong half.

## Known limits

- Hooks are read at session start, so a session launched before the hook was
  registered will not have it. Restart the session.
- A question phrased as a statement ("tell me where it is") reads as an
  instruction and is carried into the next arming rather than answered. Use the
  shell for anything subtle.
- The "last output" line in `status` is the last line in the visible pane with
  real words in it, which is often a tool hint rather than the substance.
  Reading the transcript instead of the pane would be better and is not done.
