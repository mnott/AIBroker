#!/bin/bash
# Build the CoreBluetooth peripheral helper into dist/ble/pailot-ble (macOS only).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/native/ble-peripheral"
OUT="$ROOT/dist/ble"
mkdir -p "$OUT"
swiftc -O "$SRC/PAILotBle.swift" -o "$OUT/pailot-ble" \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$SRC/Info.plist"
codesign --force --sign - --identifier org.aibroker.pailot-ble "$OUT/pailot-ble" 2>/dev/null || true
echo "built $OUT/pailot-ble"
