/**
 * test/validate.test.ts — Unit tests for IPC runtime validation.
 *
 * Run: npx tsx --test test/validate.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  validateAdapterHealth,
  validateSessionList,
  validateHubStatus,
  validateTtsResult,
  validateTranscription,
} from "../src/ipc/validate.js";

describe("validateAdapterHealth", () => {
  it("parses a valid health response", () => {
    const h = validateAdapterHealth({
      status: "ok",
      connectionStatus: "connected",
      stats: { messagesReceived: 42, messagesSent: 10, errors: 1 },
      lastMessageAgo: 5000,
      detail: "all good",
    });
    assert.equal(h.status, "ok");
    assert.equal(h.connectionStatus, "connected");
    assert.equal(h.stats.messagesReceived, 42);
    assert.equal(h.stats.messagesSent, 10);
    assert.equal(h.stats.errors, 1);
    assert.equal(h.lastMessageAgo, 5000);
    assert.equal(h.detail, "all good");
  });

  it("returns safe defaults for null input", () => {
    const h = validateAdapterHealth(null);
    assert.equal(h.status, "down");
    assert.equal(h.connectionStatus, "disconnected");
    assert.equal(h.stats.messagesReceived, 0);
    assert.equal(h.lastMessageAgo, null);
  });

  it("returns safe defaults for string input", () => {
    const h = validateAdapterHealth("garbage");
    assert.equal(h.status, "down");
  });

  it("coerces unknown status values to 'down'", () => {
    const h = validateAdapterHealth({ status: "bogus", connectionStatus: "connected" });
    assert.equal(h.status, "down");
    assert.equal(h.connectionStatus, "connected");
  });

  it("coerces unknown connectionStatus to 'disconnected'", () => {
    const h = validateAdapterHealth({ status: "ok", connectionStatus: "weird" });
    assert.equal(h.connectionStatus, "disconnected");
  });

  it("handles missing stats", () => {
    const h = validateAdapterHealth({ status: "ok", connectionStatus: "connected" });
    assert.equal(h.stats.messagesReceived, 0);
    assert.equal(h.stats.messagesSent, 0);
    assert.equal(h.stats.errors, 0);
  });
});

describe("validateSessionList", () => {
  it("parses a valid sessions response", () => {
    const sessions = validateSessionList({
      sessions: [
        { index: 1, name: "Claude Code", kind: "visual", active: true },
        { index: 2, name: "API Session", kind: "api", active: false },
      ],
    });
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0].name, "Claude Code");
    assert.equal(sessions[0].active, true);
    assert.equal(sessions[1].kind, "api");
  });

  it("returns empty array for non-object input", () => {
    assert.deepEqual(validateSessionList(null), []);
    assert.deepEqual(validateSessionList(""), []);
    assert.deepEqual(validateSessionList(42), []);
  });

  it("returns empty array for missing sessions key", () => {
    assert.deepEqual(validateSessionList({}), []);
  });

  it("skips non-object entries", () => {
    const sessions = validateSessionList({
      sessions: [
        { index: 1, name: "Valid", kind: "visual", active: true },
        "garbage",
        null,
        42,
      ],
    });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].name, "Valid");
  });
});

describe("validateHubStatus", () => {
  it("parses a full status response", () => {
    const s = validateHubStatus({
      version: "0.6.0",
      adapters: ["whazaa", "telex"],
      activeSessions: 3,
      activeSession: "Claude Code",
      adapterHealth: {
        whazaa: {
          status: "ok",
          connectionStatus: "connected",
          stats: { messagesReceived: 10, messagesSent: 5, errors: 0 },
          lastMessageAgo: 1000,
        },
      },
    });
    assert.equal(s.version, "0.6.0");
    assert.deepEqual(s.adapters, ["whazaa", "telex"]);
    assert.equal(s.activeSessions, 3);
    assert.equal(s.activeSession, "Claude Code");
    assert.equal(s.adapterHealth.whazaa.status, "ok");
  });

  it("handles empty input gracefully", () => {
    const s = validateHubStatus(null);
    assert.equal(s.version, "unknown");
    assert.deepEqual(s.adapters, []);
    assert.equal(s.activeSessions, 0);
    assert.equal(s.activeSession, null);
  });
});

describe("validateTtsResult", () => {
  it("parses valid TTS result", () => {
    const t = validateTtsResult({ generated: true, voice: "af_sky", bytes: 12345 });
    assert.equal(t.generated, true);
    assert.equal(t.voice, "af_sky");
    assert.equal(t.bytes, 12345);
  });

  it("returns defaults for bad input", () => {
    const t = validateTtsResult("bad");
    assert.equal(t.generated, false);
    assert.equal(t.voice, "unknown");
    assert.equal(t.bytes, 0);
  });
});

describe("validateTranscription", () => {
  it("parses valid transcription", () => {
    const t = validateTranscription({ text: "Hello world" });
    assert.equal(t.text, "Hello world");
  });

  it("returns empty string for missing text", () => {
    const t = validateTranscription({});
    assert.equal(t.text, "");
  });

  it("returns empty string for non-object", () => {
    const t = validateTranscription(null);
    assert.equal(t.text, "");
  });
});
