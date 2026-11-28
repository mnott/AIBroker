---
name: setup
description: >
  Install, configure and verify AIBroker, the daemon that connects Claude Code sessions to PAILot, WhatsApp, Telegram and mail.
  USE WHEN user says "set up AIBroker", "install AIBroker", "clone github.com/mnott/AIBroker and set it up",
  "make my sessions reachable from my phone", or asks whether AIBroker is healthy.
  Phase-based and idempotent: every phase checks its state first and only does what is missing.
---

# AIBroker setup

Work through the phases in order. Run the check of a phase first; if it already passes, say so and move on.

**One install route, however the user started.** Whether they said "clone github.com/mnott/AIBroker and set it up for me" or asked from scratch, install the released package (phase 2). A clone is only where these instructions came from: do not build, link or run AIBroker from it (that would run unreleased code). It can be deleted afterwards, or kept to work on AIBroker itself. Prefer `aibroker` commands over editing files by hand; `aibroker help` and `aibroker <command> --help` are the reference. Ask the user before anything that installs a service beyond the daemon, needs an API key, an account or a phone pairing, or starts a large download. Never print secrets (tokens, passwords, API keys) back.

**PAI users:** `pai setup` already installs AIBroker (package, service, MCP entry, hooks). If `aibroker doctor` is green, there is nothing more to do here except optional channels (phase 5).

## 1. Prerequisites

Check: `node --version` (needs 22 or newer, package.json engines), `claude --version`. macOS is the primary platform (launchd); Linux works with a systemd user unit and tmux (see docs/linux.md).

- Node missing or older than 22: install a current LTS (brew, nvm, or the system package manager).
- Claude Code missing: install it from its official installer, then run `claude` once to log in.
- If `npm i -g` fails with EACCES, set a prefix in the home directory: `npm config set prefix ~/.npm-global` and put `~/.npm-global/bin` on PATH.

## 2. Install or upgrade the package

Check: `aibroker --version`.

```
npm i -g https://github.com/mnott/AIBroker/releases/latest/download/aibroker.tgz   # the release asset; no npm registry
pai update --package aibroker                                                      # upgrade later (PAI users)
```

Verify: `aibroker --version` prints a version. If `aibroker` is not found, add `$(npm prefix -g)/bin` to PATH and open a new shell.

## 3. Service, MCP registration, hooks

Check: `aibroker doctor` (non-zero exit on a required failure) and `aibroker status`.

```
aibroker setup --dry-run   # show the plan, write nothing
aibroker setup             # background service (launchd / systemd user unit), MCP entry, Claude Code hooks, ~/.aibroker/env
```

`setup` is idempotent and prints what it did per step. `--no-service`, `--no-mcp`, `--no-hooks`, `--no-tts` skip a step; `--yes` answers the one TTS-backend question (detect, show download size, install) without asking; `--force` redoes a step. Tell the user the MCP tools appear in Claude Code from its next start.

## 4. Daemon

Check: `aibroker status` shows the daemon and adapter health.

```
aibroker start       # refuses when one is already running
aibroker restart     # or: aibroker stop
```

Under a HOME that is not the account home (sandbox, test) the service file is written but not loaded; `setup` prints the command to load it.

## 5. Optional channels (only on the user's request)

Ask which, if any, the user wants. Each is independent.

- **PAILot** (iOS/Android companion app): the gateway runs inside the daemon on port 8765. See docs/pailot.md for pairing. Build distribution: `aibroker ota setup-serve`, `aibroker ota publish`.
- **WhatsApp**: `npm i -g https://github.com/mnott/Whazaa/releases/latest/download/whazaa.tgz && whazaa setup` (pairs the phone by QR code; the user must scan it).
- **Telegram**: `npm i -g https://github.com/mnott/Telex/releases/latest/download/telex.tgz && telex setup` (needs the user's Telegram login).
- **Mail**: mail-ingress mailboxes are configured per README section "Mail ingress" and docs/mailbox.md; they need IMAP credentials from the user, which go into the config, never into chat output.
- **Todoist**: `aibroker todoist auth` (needs the user's API token).

## 6. Verify

`aibroker doctor` is green, `aibroker status` shows the daemon running, `aibroker ping` answers, and after restarting Claude Code the `aibroker` MCP tools are listed. Report anything that is not green with the cause `doctor` names, fix it, and rerun.

Remove everything setup added with `aibroker uninstall` (keeps `~/.aibroker` unless `--purge`).
