# aibroker-ota — OTA Install Hub

A lightweight Express service that ships iOS IPAs and Android APKs over Tailscale.
Any app (PAILot, Glidr, future apps) is one tool-call away from "installable on your device from anywhere on Tailscale".

## What it is

`aibroker-ota` is a Docker container that:
- Hosts IPA/APK files at stable URLs under `/install/<slug>/`
- Renders iOS manifest plists and install landing pages
- Gates uploads to a configurable Tailscale-user allowlist
- Exposes a JSON API under `/api/apps` for programmatic publishing

## Quick start

```bash
aibroker ota up
```

This command:
1. Writes `docker/.env` with your host UID/GID (so bind-mount writes succeed)
2. Runs `docker compose up -d`
3. Configures Tailscale Serve to proxy `/install/` and `/api/` at HTTPS

After `up`, your install URLs are at `https://<tailscale-hostname>/install/<slug>/`.

## Tailscale Serve flow

```
iPhone (Safari)
  → https://<tailscale-hostname>/install/pailot/  (HTTPS, Tailscale Serve)
  → Tailscale Serve (local proxy)
  → http://127.0.0.1:8767/install/pailot/  (aibroker-ota container)
  → itms-services:// install link
  → iOS fetches manifest.plist
  → iOS downloads .ipa and installs
```

The container never touches `tailscaled` or the Tailscale socket.
Tailscale Serve is configured by `aibroker ota up` on the host.

## Auth model

- **Reads** (`GET /api/apps`, `/install/*`): open within the tailnet — no auth required.
- **Writes** (`POST /api/apps`, `DELETE /api/apps/:slug`): require `Tailscale-User-Login` header to match `AIBROKER_OTA_PUBLISHERS`.

Tailscale Serve injects the `Tailscale-User-Login` header for requests from tailnet peers.
The container trusts this header (`TRUST_HEADER=true`) because it only binds to `127.0.0.1`.

**Known assumption / security caveat:** Local processes on the host Mac can craft arbitrary
`Tailscale-User-Login` headers when connecting to `127.0.0.1:8767` directly.
The threat model is remote attackers, not local root. If you need stronger local isolation,
set `AIBROKER_OTA_PUBLISHERS=` to empty (disabling the allowlist check, accepting any tailnet user)
or run behind a stricter proxy.

## iOS signing reality

Ad-hoc IPAs require the device's UDID in the provisioning profile.
This service is **distribution infrastructure only** — it does not bypass code signing.
To add a device: add its UDID in Apple Developer portal → regenerate provisioning profile → rebuild IPA → re-publish.

## Android note

`.aab` files (Android App Bundle) are **not** accepted. AAB is the Play Store upload format —
devices cannot install AAB directly. Only `.apk` files are accepted for sideloading.

## Publishing

### Via MCP tool (recommended)
```
ota_publish({
  slug: "pailot",
  name: "PAILot",
  bundleId: "de.mnsoft.pailot",
  version: "1.2.3",
  platform: "ios",
  filePath: "/path/to/PAILot-1.2.3.ipa"
})
```

### Via curl
```bash
curl -X POST https://<hostname>/api/apps \
  -F slug=pailot \
  -F name=PAILot \
  -F "bundleId=de.mnsoft.pailot" \
  -F version=1.2.3 \
  -F platform=ios \
  -F file=@/path/to/PAILot-1.2.3.ipa
```

## Storage

Files live at `~/.aibroker/ota/` on the host (bind-mounted to `/data` in the container):

```
~/.aibroker/ota/
  apps/
    <slug>/
      meta.json         # app metadata
      <Name>-<version>.ipa
      <Name>-<version>.apk
      icon.png          # optional
  uploads-tmp/          # multer staging (same volume — no cross-device rename)
```

**Backup consideration:** IPAs and APKs are 10–30 MB each and are rebuild artifacts.
Exclude `~/.aibroker/ota/apps/*/*.ipa` and `~/.aibroker/ota/apps/*/*.apk` from any backup.
Only `meta.json` files need backing up.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `DATA_DIR` | `/data` | Root data directory |
| `AIBROKER_OTA_PUBLISHERS` | `` | Comma-separated Tailscale login emails allowed to write |
| `TRUST_HEADER` | `true` | Trust `Tailscale-User-Login` header; set false to block all writes |

## Misc commands

```bash
aibroker ota down          # stop container
aibroker ota status        # docker ps + tailscale serve status
aibroker ota logs          # container logs
aibroker ota logs -f       # follow logs
aibroker ota setup-serve   # re-configure Tailscale Serve without restarting container
```
