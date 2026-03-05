/**
 * test/broker.test.ts — Unit tests for BrokerMessage creation and routing types.
 *
 * Run: npx tsx --test test/broker.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createBrokerMessage } from "../src/types/broker.js";
import type { BrokerMessage, BrokerMessageType } from "../src/types/broker.js";

describe("createBrokerMessage", () => {
  it("creates a message with required fields", () => {
    const msg = createBrokerMessage("whazaa", "text", { text: "hello" });
    assert.equal(msg.source, "whazaa");
    assert.equal(msg.type, "text");
    assert.equal(msg.payload.text, "hello");
    assert.equal(typeof msg.id, "string");
    assert.ok(msg.id.length > 0, "id should be a non-empty UUID");
    assert.equal(typeof msg.timestamp, "number");
    assert.ok(msg.timestamp > 0, "timestamp should be positive");
    assert.equal(msg.target, undefined);
  });

  it("sets explicit target", () => {
    const msg = createBrokerMessage("hub", "text", { text: "hi" }, "telex");
    assert.equal(msg.target, "telex");
  });

  it("preserves payload fields", () => {
    const msg = createBrokerMessage("hub", "voice", {
      buffer: "base64data",
      text: "caption",
      recipient: "user@example.com",
    });
    assert.equal(msg.payload.buffer, "base64data");
    assert.equal(msg.payload.text, "caption");
    assert.equal(msg.payload.recipient, "user@example.com");
  });

  it("preserves audioPath in payload", () => {
    const msg = createBrokerMessage("hub", "voice", {
      audioPath: "/tmp/audio.ogg",
    });
    assert.equal(msg.payload.audioPath, "/tmp/audio.ogg");
  });

  it("generates unique IDs", () => {
    const a = createBrokerMessage("test", "text", { text: "a" });
    const b = createBrokerMessage("test", "text", { text: "b" });
    assert.notEqual(a.id, b.id);
  });

  it("supports all message types", () => {
    const types: BrokerMessageType[] = ["text", "voice", "image", "video", "file", "command", "status"];
    for (const type of types) {
      const msg = createBrokerMessage("test", type, {});
      assert.equal(msg.type, type);
    }
  });

  it("handles empty payload", () => {
    const msg = createBrokerMessage("test", "status", {});
    assert.deepEqual(msg.payload, {});
  });

  it("preserves metadata in payload", () => {
    const msg = createBrokerMessage("test", "text", {
      text: "hello",
      metadata: { source: "test", priority: 1 },
    });
    assert.deepEqual(msg.payload.metadata, { source: "test", priority: 1 });
  });
});

describe("BrokerMessage structure", () => {
  it("has all required fields", () => {
    const msg: BrokerMessage = {
      id: "test-id",
      timestamp: Date.now(),
      source: "adapter",
      type: "text",
      payload: { text: "hello" },
    };
    assert.equal(msg.id, "test-id");
    assert.equal(msg.source, "adapter");
    assert.equal(msg.type, "text");
  });
});
