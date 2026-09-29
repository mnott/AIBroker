# Install

```bash
npm install -g aibroker
aibroker setup      # service + MCP registration + Claude Code hooks + ~/.aibroker/env
aibroker doctor     # every check green, or it says exactly what to fix
```

`aibroker setup` is idempotent and prints what it did per step; `--dry-run` shows the plan and writes nothing, `--no-service`, `--no-mcp` and `--no-hooks` skip a step. `aibroker uninstall` removes the service, the MCP entry and the hooks it added, and keeps `~/.aibroker` unless you pass `--purge`.

The hub owns the IPC socket at `/tmp/aibroker.sock` and the PAILot WebSocket gateway on port 8765.

| | macOS | Linux |
|---|---|---|
| Service | LaunchAgent `com.aibroker.daemon` (an existing plist is left alone unless `--force`) | `systemd --user` unit `aibroker.service`; run `sudo loginctl enable-linger $USER` once so it survives logout |
| Session host | iTerm2 (tmux optional) | tmux |
| Prerequisites | Node.js 22+, iTerm2, ffmpeg | Node.js 22+, tmux, ffmpeg |
| Guide | [docs/macos.md](macos.md) | [docs/linux.md](linux.md) — no macOS needed anywhere |

From a source checkout instead: `git clone https://github.com/mnott/AIBroker && cd AIBroker && npm install && npm run build && node dist/daemon/cli.js setup`.

## Connect an adapter

```bash
# WhatsApp
npm install -g whazaa
whazaa setup                 # pair the phone (QR code), once
whazaa service start         # run the watcher as a service (LaunchAgent on macOS, systemd user unit on Linux)

# Telegram
npm install -g @tekmidian/telex
telex setup                  # log in to Telegram, once
telex service start
```

`<bin> service start|stop|status|unit` manages the background service; see [macos.md](macos.md) and [linux.md](linux.md). Once connected, messages from your phone route to Claude and replies come back automatically.
