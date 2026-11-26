#!/bin/bash
# Build the MultipeerConnectivity helper into dist/p2p/pailot-p2p (macOS only).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/native/p2p-peripheral"
OUT="$ROOT/dist/p2p"
mkdir -p "$OUT"
swiftc -O "$SRC/PAILotP2p.swift" -o "$OUT/pailot-p2p" \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$SRC/Info.plist"
codesign --force --sign - --identifier org.aibroker.pailot-p2p "$OUT/pailot-p2p" 2>/dev/null || true
echo "built $OUT/pailot-p2p"
