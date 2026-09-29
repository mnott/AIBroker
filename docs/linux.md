# AIBroker on Linux

AIBroker runs on Linux without any macOS dependency. The session host is
**tmux**, the service is a **systemd user unit**, and nothing on the Linux path
calls AppleScript, `launchctl` or other macOS tools: whenever `process.platform`
is not `darwin`, tmux is the only transport.

Tested end to end on Ubuntu 26.04 (aarch64, real systemd, from a clean install
with only Claude Code present), and with the container smoke test on Debian
bookworm (aarch64 and x86_64). See [Testing](#testing).

For macOS see [macos.md](macos.md).

## 1. Prerequisites

Node.js 22 or newer, tmux 3.x, ffmpeg. Optional: `whisper` (speech to text),
`sox` (local dictation), and one of `paplay`, `aplay` or `ffplay` for local audio.

```bash
# Debian / Ubuntu
sudo apt install nodejs npm tmux ffmpeg
# Fedora
sudo dnf install nodejs npm tmux ffmpeg-free
# Arch
sudo pacman -S nodejs npm tmux ffmpeg
```

Check that `node --version` prints 22 or higher; some distributions ship older
versions (use NodeSource, `nvm`, or a `nodejs22` package). Only the Debian/Ubuntu
line is covered by the automated tests; the Fedora and Arch lines are untested.

Right after a fresh boot, Ubuntu's automatic updates can hold the package lock
for several minutes (`Could not get lock /var/lib/dpkg/lock-frontend`). Wait, or
let apt wait for you: `sudo apt-get -o DPkg::Lock::Timeout=600 install …`.

## 2. Claude Code

Install it the way Anthropic documents it. The native installer needs no
Node.js and puts `claude` into `~/.local/bin`:

```bash
curl -fsSL https://claude.ai/install.sh | bash
claude            # first start: pick a theme, then log in
```

On a machine without a local browser (SSH, VNC), the login shows a long URL that
wraps across lines. Press `c` in the login screen to copy it, open it in any
browser, sign in, and paste the code back into the terminal. The first start in
a new folder asks whether you trust it; that question comes from Claude Code,
not from AIBroker.

## 3. AIBroker

```bash
npm install -g aibroker          # or, without sudo: npm install -g --prefix ~/.local aibroker
aibroker setup
aibroker doctor
```

`aibroker setup` is idempotent and prints what it did, step by step:

- **Service.** Writes `~/.config/systemd/user/aibroker.service` with the
  absolute node binary and the installed `cli.js`, the `PATH` and `AIBROKER_*`
  variables of the shell you ran it from, `EnvironmentFile=-%h/.aibroker/env`
  and `UMask=0077`, then runs `systemctl --user daemon-reload` and `enable --now`.
- **Claude Code.** Registers the `aibroker` MCP server (`claude mcp add --scope
  user`), then reads `~/.claude.json` back to confirm the entry is there; if the
  CLI did not write it, setup writes it itself. Other servers are never touched.
- **Hooks.** Merges the hub's Claude Code hooks into `~/.claude/settings.json` by
  absolute path (mailbox drain, `/manage`, route guard, progress, rename title),
  without duplicating entries.
- **Env.** Creates `~/.aibroker/env` (mode 0600) from a commented template if it
  does not exist.

The first backup of every file setup edits is kept as `<file>.bak` and never
overwritten; later backups get a timestamp. `--dry-run` prints the plan and
writes nothing; `--no-service`, `--no-mcp`, `--no-hooks` skip a step.

**Linger.** Without it, systemd stops user services when you log out. Setup
never runs sudo; if linger is off it tells you to run, once:

```bash
sudo loginctl enable-linger "$USER"
```

`aibroker doctor` checks node, the transport, tmux (and that its server is
reachable as your user), ffmpeg, the optional tools, the service, linger, the
daemon socket, the MCP entry, the hooks, and the modes of `~/.aibroker/env`
and the logs. Each failing line ends with the fix; the exit code is non-zero
when a required check fails. The "no tmux server reachable" warning is normal
until you start tmux.

`aibroker uninstall` removes the service, the MCP entry and the hooks setup
added, and keeps `~/.aibroker` unless you pass `--purge`.

## 4. Daily use

```bash
tmux new -s work                  # your tmux, as usual
aibroker launch ~/src/myproject   # new tmux window "myproject" running claude there
aibroker sessions                 # name, transport, state (at-prompt / busy / shell), directory
aibroker send myproject "hello"   # type a message into that session
aibroker status                   # hub health, including "Transport: tmux (linux)"
aibroker restart                  # or: stop / start
```

- `aibroker launch <dir>` opens a new window in your current tmux session; run
  outside tmux it creates a detached session called `aibroker` and prints how to
  attach. Launching a directory that already has a session attaches instead of
  opening a second one. `--name N` overrides the window name (default: the
  directory's basename).
- The window and pane title stay pinned to the session name, so Claude Code
  retitling its pane never breaks addressing by name. Whether a session is idle
  (`at-prompt`) or working (`busy`) is read from the pane content, so custom
  statuslines below Claude's input box are fine.
- Claude sessions you start yourself in tmux are found too; `aibroker launch` is
  simply the convenient way.
- `aibroker stop` / `restart` drive the systemd unit when it is installed,
  otherwise they ask the daemon to shut down over its socket, with a pidfile
  (`~/.aibroker/daemon.pid`, 0600) as the last resort.
- From inside Claude Code, the same things are MCP tools (`aibroker_sessions`,
  `aibroker_send_to_session`, …).

**Session backup across reboots.** `aibroker sessions install` adds a systemd
user timer (`aibroker-sessions-snapshot.timer`, every 5 minutes) that records
your Claude sessions; after a reboot `aibroker sessions restore` reopens each
one as a tmux window through the same launch path.

## 5. PAI on Linux (optional)

[PAI](https://www.npmjs.com/package/@tekmidian/pai) adds memory, the PAI
statusline, and workers (`pai worker run`). It installs and runs on Linux the
same way:

```bash
npm install -g @tekmidian/pai
pai setup --yes --storage sqlite      # scripted, every default; or plain `pai setup` for the wizard
systemctl --user status pai-daemon    # the PAI daemon is a systemd user unit too
pai worker providers                  # "anthropic [built-in]" and "workers are on"
```

Restart Claude Code afterwards; the statusline and hooks come from
`~/.claude/settings.json`. Workers use your Claude Code login (Max plan, no API
key), and inside tmux `pai worker run` opens a pane that follows the worker and
closes itself when the worker ends.

**Postgres instead of SQLite.** PAI's Postgres backend (pgvector) runs in Docker
on the same machine:

```bash
sudo apt install docker.io docker-compose-v2
sudo usermod -aG docker "$USER"                 # then log out and in (or: sg docker -c '…')
export PAI_PG_SHARED_BUFFERS=256MB              # on small machines; the default is 1GB
pai setup --yes --storage postgres
docker ps --filter name=pai-pgvector            # expect "(healthy)"
```

The container (`pgvector/pgvector:pg17`) listens on `127.0.0.1:5432` only and
restarts with Docker. The PAI daemon waits for it at boot.

## 6. Messengers and PAILot (optional)

WhatsApp (Whazaa) and Telegram (Telex) run as their own systemd user services:

```bash
npm install -g whazaa            # Telegram: npm install -g @tekmidian/telex
whazaa setup                     # pair the phone once (telex setup: Telegram login)
whazaa service start             # telex service start
whazaa service status
```

`<bin> service start|stop|status|unit` writes and drives
`~/.config/systemd/user/<bin>-watcher.service` with your `PATH` and the
`AIBROKER_*` / `WHAZAA_*` / `TELEX_*` variables; logs go to
`~/.local/state/<bin>/watch.log` (directory 0700, file 0600). Telex needs
`TELEGRAM_API_ID` and `TELEGRAM_API_HASH` (exported, or in
`~/.telex/credentials`). Pairing a phone (WhatsApp QR, Telegram login) works as
on macOS; it has not yet been exercised on Linux by the automated tests.

The PAILot app connects to the hub on port 8765. To reach it from your phone
outside the local network, put the machine on [Tailscale](https://tailscale.com)
(`sudo tailscale up`) and point PAILot at the machine's Tailscale name.

## 7. Environment

| Variable | Meaning |
|----------|---------|
| `AIBROKER_TRANSPORT` | `tmux` or `iterm`. Unset means tmux on Linux, auto-detect on macOS |
| `AIBROKER_<NAME>_BIN` | Absolute path override for a helper: `CLAUDE`, `FFMPEG`, `WHISPER`, `SOX`, `TAILSCALE`, `PAPLAY`, `APLAY`, `FFPLAY`. Otherwise looked up in `~/.local/bin`, `/usr/local/bin` and `PATH` at the moment of use, so a tool installed later is found without a restart |
| `AIBROKER_WHISPER_MODEL` | Whisper model (default `small`) |
| `TMUX_TMPDIR` | Where the tmux socket lives, if not `/tmp` |
| `PAILOT_PORT` | PAILot broker port (default 8765) |

Put them in `~/.aibroker/env` (read by the service) and run `aibroker restart`.
Everything else (Todoist, A2A, adapter tokens) is configured as on macOS; see
[configuration.md](configuration.md).

## 8. Troubleshooting

- **`doctor`: "no tmux server reachable".** Start tmux as the same user. The hub
  and tmux must share a socket: compare `tmux display -p '#{socket_path}'` with
  what the service sees; if you set `TMUX_TMPDIR` in your shell, put it in
  `~/.aibroker/env` too. A tmux started with `sudo` is invisible to the hub.
- **The service stops when you log out.** Linger is off: `sudo loginctl enable-linger "$USER"`.
- **The service cannot find `claude`, `tmux` or `ffmpeg`.** The unit carries the
  `PATH` of the shell you ran `aibroker setup` in. Fix `PATH` and run
  `aibroker setup` again; it rewrites the unit and restarts the service.
- **"Failed to connect to bus".** No user session bus (typical over `su` or in a
  container). Log in with `ssh`, use `machinectl shell "$USER"@`, or
  `export XDG_RUNTIME_DIR=/run/user/$(id -u)`.
- **`npm install -g` wants sudo.** Use `--prefix ~/.local` and keep `~/.local/bin`
  on `PATH`.
- **File names are case-sensitive.** Paths that happen to work on a Mac
  (`~/.claude/Skills` vs `~/.claude/skills`) do not on Linux; report any such
  error.
- **Logs.** `journalctl --user -u aibroker -n 100` (PAI: `-u pai-daemon`). On
  Linux the log must never mention `osascript` or iTerm; if it does, check
  `AIBROKER_TRANSPORT`.

## 9. What stays macOS-only

- **`/ss` screenshots as images.** On tmux the command replies with the pane's
  text instead. Window screenshots, screen-lock detection and pointer or dialog
  control need macOS.
- **iTerm2 visuals:** tab colours, badges, revealing a tab.
- **Local dictation chimes** (`afplay`); dictation itself needs `sox` and a microphone.
- **HEIC images** from PAILot are kept as HEIC (no `sips`).

## Testing

- `npm run test:linux` builds a Debian container and runs the daemon, tmux, a
  stand-in `claude`, launch, sessions, send, restart and stop. Any machine with
  Docker; add `--platform linux/amd64` to the `docker build`/`run` for x86_64.
- `npm run test:vm` (`test/linux/vm-acceptance.sh`, macOS host with Parallels)
  reverts an Ubuntu VM to a clean snapshot and runs the whole flow above with
  real systemd, from package install to uninstall. It is one blocking command
  that prints PASS/FAIL/SKIP per step and saves logs per run. Flags:
  `--pai <tgz>` (PAI install + setup), `--postgres` (Docker + pgvector),
  `--real-claude` (a logged-in Claude Code launched in tmux, the PAI statusline,
  a task delegated to a PAI worker, the tests it wrote), `--reboot`,
  `--adapters` (Whazaa/Telex services), `--keep` (leave the VM running).
- **Stages.** `--save-stages` snapshots the VM after each stage as
  `aib-stage: prereqs`, `aib-stage: aibroker` and `aib-stage: pai`;
  `--start-at <stage>` starts from one of them instead of the base (about 90 s
  instead of 3–4 min). A stage whose tarball changed is reinstalled
  automatically. Only `aib-stage: …` snapshots are ever replaced; the base is
  never touched. The VM name, base snapshot, user and shared folder come from
  `AIBROKER_VM_*` variables; see the script header.
