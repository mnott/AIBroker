# Wi-Fi direct (MultipeerConnectivity) transport

Optional second near-link next to [BLE](ble-transport.md). It carries the same `(mqtt-topic, json)` envelopes between the PAILot app and the hub over Apple MultipeerConnectivity (MC): iPhone to Mac over AWDL (peer-to-peer Wi-Fi), no shared network or broker needed. Link order in the app: p2p, then network (MQTT), then BLE as fallback. App light colours: Wi-Fi direct purple, Bluetooth blue, network green.

## Enable

```
AIBROKER_P2P=1
AIBROKER_P2P_TOKEN=<token>      # falls back to AIBROKER_BLE_TOKEN
AIBROKER_P2P_NAME="PAILot Hub"  # optional display name
AIBROKER_P2P_HELPER=/path/to/pailot-p2p   # optional helper override
```

Off by default. Build the helper with `npm run build:p2p` (macOS, needs the Swift toolchain) -> `dist/p2p/pailot-p2p`. The daemon spawns `src/adapters/pailot/p2p-bridge.ts` at start and restarts the helper with backoff.

## Protocol

* MC `serviceType` `pailot-p2p`; the Mac advertises (`discoveryInfo {"v":"2"}`), the iPhone browses and invites. The helper accepts every invitation (`encryptionPreference .required`); authentication is the application layer. A peer without a valid v2 handshake is disconnected after 5 s, as is one with a wrong token.
* Payload: `MCSession.send(.reliable)` of byte chunks (max 64 KiB) of the same length-framed stream as BLE (`ble-frame.ts`, envelope `{"t","p"}`, AES-256-GCM v2 handshake from `ble-crypto.ts`, `ble/hello` / `ble/ready`). The receiver reassembles per peer.
* No size routing: large payloads (images, voice) go over this link unchanged.
* Helper JSON lines. Events: `ready`, `advertising`, `peer {id,name,state}`, `data {peer,b64}`, `error {msg}`. Commands: `send {peer,b64}`, `disconnect {peer}`, `stop`. Several peers may be connected; MC cannot kick one peer, so `disconnect` cancels the session and the peers re-invite and re-authenticate.
* The MQTT out-tap is now slotted (`setMqttOutTap(fn, slot)`), so BLE and P2P bridges run side by side. A message may arrive on several links; the app deduplicates by `msgId`.

## macOS requirements

* **Local Network privacy.** macOS asks once for Local Network access for the helper. The helper embeds an `Info.plist` (linker `-sectcreate __TEXT __info_plist`) with `NSLocalNetworkUsageDescription` and `NSBonjourServices = [_pailot-p2p._tcp, _pailot-p2p._udp]`; without them advertising fails silently. Grant it in System Settings > Privacy & Security > Local Network. The prompt is tied to the code signature identifier (`org.aibroker.pailot-p2p`).
* **Ad-hoc signing.** `build-p2p-helper.sh` signs with `codesign --sign -` and a fixed identifier so the privacy grant survives rebuilds of the same identifier. Rebuilding with a different signature may re-prompt.
* The helper holds a no-idle-sleep activity while running.

## Limits

* iOS suspends MC sessions when the app is backgrounded: the app must hand over to MQTT/BLE on background and re-browse/reconnect on foreground. Android has no MC; it keeps network/BLE.
* Realistic indoor range is about 10-30 m (AWDL, walls dominate); it drops to BLE-like behaviour only through app fallback, not within MC.
* Battery/radio: AWDL time-slices the Wi-Fi radio. While a session is active it can add latency to the infrastructure Wi-Fi connection of both devices and costs noticeably more battery than idle BLE; advertising alone is cheap, an active session is not. Keep "Near link" at `ble` or `off` on battery-sensitive phones.

## Why MultipeerConnectivity and not Network.framework

MC is the only Apple API that gives infrastructure-less iPhone to Mac transport with discovery, encryption and AWDL in a few lines on both sides, and the app already ships a matching browser. `Network.framework` (`NWListener`/`NWBrowser` with `includePeerToPeer`) is the better long-term base: macOS 27 marks `MCSession`/`MCNearbyServiceAdvertiser` deprecated ("Use Network Framework instead"), and it gives real stream backpressure and per-connection control (kicking a single peer). The wire contract here (bytes of the framed stream, JSON helper protocol) is transport-independent, so only `PAILotP2p.swift` and the iOS side need to change for a migration.
