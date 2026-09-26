import "./home-guard.js";
/**
 * pailot/control/in must reach the dedicated control branch, not the
 * session-id regex (which used to match "control" as a session id and
 * skip the hello / debug_state_response interception — see mqtt-broker.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleInboundPublish, setMqttInboundHandler } from "../src/adapters/pailot/mqtt-broker.js";

function packet(topic: string, payload: Record<string, unknown>) {
  return { topic, payload: Buffer.from(JSON.stringify(payload)) };
}

const client = { id: "pailot-test-client", conn: { remoteAddress: "127.0.0.1", remotePort: 1234 } };

/** Capture log() output (writes straight to stderr) for one call. */
function captureLog(fn: () => void): string {
  const orig = process.stderr.write.bind(process.stderr);
  let out = "";
  process.stderr.write = ((chunk: any) => { out += chunk.toString(); return true; }) as typeof process.stderr.write;
  try {
    fn();
  } finally {
    process.stderr.write = orig;
  }
  return out;
}

test("hello on pailot/control/in is logged and not forwarded to the hub", () => {
  let forwarded: unknown = undefined;
  setMqttInboundHandler((sessionId, type, payload) => { forwarded = { sessionId, type, payload }; });

  const out = captureLog(() => {
    handleInboundPublish(
      packet("pailot/control/in", { msgId: "hello-1", type: "command", command: "hello", args: { device: "iPhone", os: "iOS 18" } }),
      client,
    );
  });

  assert.match(out, /\[MQTT\] hello from pailot-test-client/);
  assert.equal(forwarded, undefined, "hello must not be forwarded to the hub");
});

test("catch_up on pailot/control/in is forwarded exactly as before", () => {
  let forwarded: { sessionId: string | undefined; type: string; payload: Record<string, unknown> } | undefined;
  setMqttInboundHandler((sessionId, type, payload) => { forwarded = { sessionId, type, payload }; });

  const payload = { msgId: "catchup-1", type: "command", command: "catch_up", args: { since: 0 } };
  handleInboundPublish(packet("pailot/control/in", payload), client);

  assert.ok(forwarded, "catch_up must reach the hub");
  assert.equal(forwarded!.sessionId, undefined, "control commands carry no sessionId");
  assert.equal(forwarded!.type, "command");
  assert.equal((forwarded!.payload as Record<string, unknown>).command, "catch_up");
});
