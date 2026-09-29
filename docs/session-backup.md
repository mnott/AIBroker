# Session backup across reboots (optional)

```bash
aibroker sessions install
```

Installs a LaunchAgent (`com.aibroker.sessions-snapshot`, macOS) that records your open Claude sessions (name + directory) every 5 minutes. Around a reboot:

```bash
aibroker sessions checkpoint   # before: tells each open session to persist its state
# reboot
aibroker sessions restore      # after: reopens every session in its own iTerm2 tab
```

`checkpoint` waits for each session to actually finish saving and prints a per-session result, so a session that never reacted is reported instead of silently skipped. Retry just those with `--only NAME`; raise `--timeout SECONDS` for slow ones.

`restore` relaunches a fresh named session per entry (which `go`s to pick up that project's saved state) — it does not rely on `claude --resume`.

The manifest (`~/.aibroker/session-restore.json`) is a **registry, not a mirror**: snapshots merge into it, so closing a session — or shutting everything down before a reboot — never removes anything. Entries leave only via `aibroker sessions forget NAME` or `aibroker sessions prune --older-than DAYS`, and every write keeps a `.bak`. See `aibroker sessions help` for the rest.
