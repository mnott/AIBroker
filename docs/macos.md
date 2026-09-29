# AIBroker on macOS

On macOS the hub runs as a **LaunchAgent** and drives Claude Code sessions in
**iTerm2** (through AppleScript) and, if you use it, **tmux**. With
`AIBROKER_TRANSPORT` unset it looks at both and routes each session to whichever
host it lives in.

For Linux see [linux.md](linux.md).

## 1. Prerequisites

Node.js 22 or newer, iTerm2, ffmpeg. Optional: tmux, `whisper` (speech to text),
`sox` (local dictation).

```bash
brew install node ffmpeg          # optional: brew install tmux sox openai-whisper
```

Install Claude Code as Anthropic documents it (`curl -fsSL
https://claude.ai/install.sh | bash`, or Homebrew) and log in once with `claude`.

## 2. AIBroker

```bash
npm install -g aibroker
aibroker setup
aibroker doctor
```

`aibroker setup` is idempotent and prints what it did, step by step:

- **Service.** Writes `~/Library/LaunchAgents/com.aibroker.daemon.plist` with the
  absolute node binary, the installed `cli.js`, and the `PATH` and `AIBROKER_*`
  variables of your shell, then loads it with `launchctl bootstrap`. launchd
  does not give services your shell's `PATH` (no `/opt/homebrew/bin`), which is
  why setup records it. An existing plist is left alone unless you pass
  `--force`; `--dry-run` shows what would differ. The daemon log is
  `~/.aibroker/daemon.log` (0600).
- **Claude Code, hooks, env** exactly as on Linux: the `aibroker` MCP server
  (verified after registering), the hub's hooks in `~/.claude/settings.json`,
  and `~/.aibroker/env` (0600). The first backup of every edited file is kept as
  `<file>.bak`.

`aibroker uninstall` removes what setup added (`--purge` also deletes `~/.aibroker`).

**Permissions.** The first time the hub drives iTerm2, macOS asks whether it may
control iTerm (Automation); allow it. Image screenshots (`/ss`) additionally
need Screen Recording for the process that runs the hub.

## 3. Daily use

```bash
aibroker launch <pai-project|dir>   # a PAI project name opens its session; a path opens Claude there
aibroker sessions                   # name, transport (iterm/tmux), state, directory
aibroker send <name> "hello"
aibroker status                     # includes "Transport: iterm+tmux (auto)"
aibroker restart                    # or: stop / start
```

A bare word is treated as a PAI project name when PAI is installed; anything
that looks like a path is a directory. With iTerm2 the session opens in a new
tab; inside tmux, in a new tmux window.

**Session backup across reboots.** `aibroker sessions install` adds a LaunchAgent
(`com.aibroker.sessions-snapshot`, every 5 minutes); `aibroker sessions
checkpoint` before and `aibroker sessions restore` after a reboot reopen every
session in its own iTerm2 tab. Details in the README.

## 4. PAI, messengers, PAILot

- **PAI:** `npm install -g @tekmidian/pai && pai setup`; the PAI daemon runs as a
  LaunchAgent. Postgres (pgvector) runs in Docker Desktop, or use
  `--storage sqlite`.
- **WhatsApp / Telegram:** `npm install -g whazaa` / `npm install -g
  @tekmidian/telex`, pair once with `whazaa setup` / `telex setup`, then
  `whazaa service start` / `telex service start`. On
  macOS these write LaunchAgents (`com.whazaa.watcher`, `com.telex.watcher`) with
  your `PATH` and `AIBROKER_*` variables; their logs are created 0600. Whazaa logs to
  `~/Library/Logs/whazaa/watch.log` (0600; `/tmp/whazaa-watch.log` is a symlink
  for older tooling).
- **PAILot** connects to port 8765; for access from outside your network use
  Tailscale.

## 5. Troubleshooting

- **`status` says "degraded — iTerm AppleScript session enumeration is failing".**
  The hub keeps the last good session list and alerts only after two minutes of
  continuous failure. The usual cause is a process that was started with iTerm's
  `__CFBundleIdentifier` in its environment and now registers under iTerm's
  bundle id, so AppleScript talks to the wrong process; the alert names it
  (`lsappinfo list | grep -i iterm`). Quit or kill that process; iTerm itself
  does not need a restart. The hub strips that variable from everything it
  starts.
- **A tool is not found by the service** (`ffmpeg`, `whisper`, `claude`). Run
  `aibroker setup --force` from a shell with the right `PATH`, or set
  `AIBROKER_<NAME>_BIN` in `~/.aibroker/env`. Tools are looked up at the moment
  of use, so something installed later is found without a restart.
- **Logs.** `~/.aibroker/daemon.log`; `aibroker doctor` checks that it and
  `~/.aibroker/env` are 0600.

## 6. Environment

Same variables as on Linux; see [linux.md § Environment](linux.md#7-environment).
`AIBROKER_TRANSPORT=tmux` makes the hub ignore iTerm2 entirely, which is how you
get Linux behaviour on a Mac.
