# Pair Programming, for Agents

Two Claude sessions can work the same repository overnight while a third supervises them. Not a swarm — a **pair**, with a manager keeping both pointed at the work.

```
     you ──► manager session ──┬──► worker A   (owns Sources/, drives the screen)
        (asleep)               └──► worker B   (owns tools/, its own git worktree)
```

The manager is an ordinary Claude session with the `manage` CLI. It does four things the workers cannot do for themselves.

**It holds the objective.** `manage <session> set "<objective>"` stores a standing goal; the manager re-types it into the pane whenever the session stops. A session that finishes a task and would otherwise idle gets pointed at the next one. `manage <session> add` appends a rule to every future arming, so a correction made once survives every restart.

**It refuses to let a session stand down.** Workers ask to be released when they judge themselves done. The manager declines and re-arms — the objective says who ends it, and it is not the worker.

**It watches the context wall.** At 82% it asks for a handover into a named file; the session writes what a compaction would destroy and carries on working. Sessions routinely reached 99% and compacted with the record already on disk.

**It arbitrates the split.** Each worker owns a set of directories and a separate git worktree, and anything across the line is asked for by name. This is not tidiness: two sessions in one tree destroyed each other's uncommitted work twice in one night, once through a directory-wide `git add` and once through `git checkout --`.

Exactly one session may drive the screen. The pointer grant is machine-wide, so exclusivity is a coordination rule rather than a lock: the worker without it sends precise requests — what to open, what to do, what to read back — to the one that has it.

```bash
aibroker manage worker-a "objective, in one line"      # store it
aibroker manage worker-a hands on for 8 hours          # grant the screen, expires by itself
aibroker manage worker-a now                           # arm it immediately
aibroker manage worker-a handover Notes/handover.md    # where it writes before compacting
aibroker manage worker-a status                        # what it is doing, and what the manager has done
```

What makes this work is not autonomy but **refusal**. The instructive failures were all instruments reporting success while measuring nothing: a guard that exempted the case it existed to stop, a mutation test whose mutation never applied, a screenshot of the previous build, a message delivered to the wrong session, a session timestamping eight hours of work from a clock it carried in context rather than one it read. Every one of them looked like progress. The manager's job is to be a second reader who asks what was actually measured.

See [docs/managed-sessions.md](managed-sessions.md) and [docs/session-watchdog.md](session-watchdog.md).
