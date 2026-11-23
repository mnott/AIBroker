import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readClaudeRegistry, isNativePeer } from "../src/core/native-peers.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "native-peers-"));
  const w = (pid: number, o: object) => writeFileSync(join(dir, `${pid}.json`), JSON.stringify({ pid, kind: "interactive", ...o }));
  w(1, { sessionId: "with-sock", messagingSocketPath: "/tmp/x.sock", peerProtocol: 1 });
  w(2, { sessionId: "no-sock" });
  w(3, { sessionId: "dead", messagingSocketPath: "/tmp/y.sock", peerProtocol: 1 });
  w(4, { sessionId: "bg", kind: "background", messagingSocketPath: "/tmp/z.sock", peerProtocol: 1 });
  writeFileSync(join(dir, "junk.json"), "{");
  return dir;
}

test("native detection from a temp sessions dir", () => {
  const dir = setup();
  try {
    const registry = readClaudeRegistry(dir);
    assert.equal(registry?.length, 4);
    const isAlive = (pid: number) => pid !== 3;
    assert.equal(isNativePeer("with-sock", { registry, isAlive }), true);
    assert.equal(isNativePeer("no-sock", { registry, isAlive }), false);
    assert.equal(isNativePeer("dead", { registry, isAlive }), false);
    assert.equal(isNativePeer("bg", { registry, isAlive }), false);
    assert.equal(isNativePeer("absent", { registry, isAlive }), false);
  } finally { rmSync(dir, { recursive: true }); }
});

test("unknown is native: no session id or unreadable registry", () => {
  assert.equal(readClaudeRegistry("/nonexistent-dir-xyz"), undefined);
  assert.equal(isNativePeer("x", { registry: undefined }), true);
  assert.equal(isNativePeer(undefined, { registry: [] }), true);
});
