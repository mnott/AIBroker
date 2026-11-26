# BLE transport for PAILot

BLE is a byte pipe carrying the same `(mqtt-topic, json-payload)` pairs the app and hub already exchange over MQTT. No second protocol.

## Design

- Hub = BLE peripheral, app = central. A native helper (`native/ble-peripheral/PAILotBle.swift`, built to `dist/ble/pailot-ble`) owns CoreBluetooth; the daemon (`src/adapters/pailot/ble-bridge.ts`) talks to it over JSON lines on stdin/stdout.
- Envelope: `{"t": "<topic>", "p": <payload>}`. Frame = 4-byte big-endian length + envelope JSON (max 16 MiB), cut into chunks of ATT MTU - 3 (max 512, 20 when unknown). The receiver reassembles arbitrary splits (`ble-frame.ts`). A corrupt frame is dropped; an oversize length drops the link.
- Inbound: frames go to `handleInboundPublish` (same dedup, session switching, commands). Voice notes arrive as `audioBase64` and are transcribed on the Mac by local whisper (log: `[BLE] voice note -> local STT`).
- Outbound: `setMqttOutTap` in `mqtt-broker.ts` sees every publish, even with no MQTT clients. Retained topics (sessions, status) are cached and replayed after `ble/ready`.
- GATT: service `7A1F0001-3C5B-4D2E-9A41-5041494C4F54`; RX (app writes) `...0002...`; TX (hub notifies) `...0003...`. Both require encryption, so macOS pairs/bonds on first use.
- Handshake: app sends `ble/hello {token, app}`; hub checks the token in constant time, answers `ble/ready {v:1}` or drops the link. Until ready all other frames are ignored. App pings every 15 s (`ble/ping`), hub answers `ble/pong`; the app treats 40 s without pong as link loss.
- Helper protocol additions beyond the shared spec: `{"cmd":"drop"}` (rebuild the GATT service to invalidate the central; CoreBluetooth cannot disconnect a central directly).

## Config (env)

| Variable | Meaning |
| --- | --- |
| `AIBROKER_BLE=1` | enable (daemon starts/stops the bridge next to the MQTT broker) |
| `AIBROKER_BLE_TOKEN` | required shared secret |
| `AIBROKER_BLE_NAME` | advertised name, default `PAILot Hub` |
| `AIBROKER_BLE_HELPER` | helper binary override; default `dist/ble/pailot-ble` |

Build the helper with `npm run build:ble` (swiftc, Info.plist with `NSBluetoothAlwaysUsageDescription` embedded via `-sectcreate`, ad-hoc signed). The helper is restarted with exponential backoff if it exits. `getBleStatus()` reports advertising / connected / ready / mtu.

## Pairing and token

First connection triggers the OS pairing dialog (encrypted characteristics). The token is a second, application-level check, so a bonded stranger still cannot issue commands. Bluetooth permission for the helper is granted once under System Settings > Privacy > Bluetooth.

## Lid closed

The helper holds an idle-sleep assertion (`ProcessInfo.beginActivity(.idleSystemSleepDisabled)`), but a closed lid on battery still sleeps the Mac. It works with the lid closed only while the Mac stays awake (power connected + external display, or `caffeinate -s` / clamshell setup).

## Background behaviour on the phone

- iOS: use the `bluetooth-central` background mode. It keeps the connection and wakes the app for notifications, but the app can still be suspended or killed; use CoreBluetooth state restoration to reconnect.
- Android: a foreground service is needed for reliable background BLE.

## Limits and open issues

- Throughput is roughly 20-100 KB/s, so a 300 KB TTS voice note takes several seconds (3-15 s).
- One central at a time, newest wins.
- Messages in flight when BLE drops rely on the app's catch_up / retry over MQTT.
- Dropping a link is done by rebuilding the service; a central that stays bonded reconnects and must re-send hello.
- Not yet tested end to end against the app; the live check covered advertising only.
