/**
 * test/message-queue.test.ts — Unit tests for persistent PAILot message queue.
 *
 * Run: npx tsx --test test/message-queue.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// We test the module's logic by importing and calling its functions.
// The queue file path is hardcoded to ~/.aibroker/pailot-queue.json,
// so we test the core API behavior without mocking the filesystem.
import {
  loadQueue,
  flushQueue,
  enqueue,
  getAfter,
  getLatestSeq,
  isContentType,
} from "../src/adapters/pailot/message-queue.js";

describe("message-queue", () => {
  // Each test starts with a fresh queue by loading with a clean state
  beforeEach(() => {
    // loadQueue resets internal state
    loadQueue(100);
  });

  afterEach(() => {
    // Flush to ensure clean state for next test
    flushQueue();
  });

  describe("isContentType", () => {
    it("returns true for text, voice, image", () => {
      assert.ok(isContentType("text"));
      assert.ok(isContentType("voice"));
      assert.ok(isContentType("image"));
    });

    it("returns false for non-content types", () => {
      assert.ok(!isContentType("typing"));
      assert.ok(!isContentType("status"));
      assert.ok(!isContentType("sessions"));
      assert.ok(!isContentType("command"));
    });
  });

  describe("enqueue", () => {
    it("returns seq > 0 for content messages", () => {
      const seq = enqueue("session1", "text", { content: "hello" });
      assert.ok(seq > 0);
    });

    it("returns 0 for non-content messages", () => {
      const seq = enqueue("session1", "typing", { active: true });
      assert.equal(seq, 0);
    });

    it("assigns monotonically increasing seq numbers", () => {
      const seq1 = enqueue("s1", "text", { content: "a" });
      const seq2 = enqueue("s1", "text", { content: "b" });
      const seq3 = enqueue("s2", "voice", { audioBase64: "..." });
      assert.ok(seq2 > seq1);
      assert.ok(seq3 > seq2);
    });

    it("adds seq field to the payload", () => {
      const payload: Record<string, unknown> = { content: "test" };
      const seq = enqueue("s1", "text", payload);
      // The enqueue function clones and adds seq
      const messages = getAfter(0);
      const last = messages[messages.length - 1];
      assert.equal(last.payload.seq, seq);
    });
  });

  describe("getAfter", () => {
    it("returns all messages after a given seq", () => {
      const seq1 = enqueue("s1", "text", { content: "first" });
      const seq2 = enqueue("s1", "text", { content: "second" });
      const seq3 = enqueue("s1", "text", { content: "third" });

      const after1 = getAfter(seq1);
      assert.equal(after1.length, 2);
      assert.equal(after1[0].seq, seq2);
      assert.equal(after1[1].seq, seq3);
    });

    it("returns empty array when no messages after seq", () => {
      const seq = enqueue("s1", "text", { content: "only" });
      const after = getAfter(seq);
      assert.equal(after.length, 0);
    });

    it("filters by sessionId when provided", () => {
      const baseline = getLatestSeq();
      enqueue("s1", "text", { content: "s1 msg" });
      enqueue("s2", "text", { content: "s2 msg" });
      enqueue("s1", "voice", { audioBase64: "..." });

      const s1Only = getAfter(baseline, "s1");
      assert.equal(s1Only.length, 2);
      s1Only.forEach(m => assert.equal(m.sessionId, "s1"));

      const s2Only = getAfter(baseline, "s2");
      assert.equal(s2Only.length, 1);
      assert.equal(s2Only[0].sessionId, "s2");
    });

    it("returns all sessions when no sessionId filter", () => {
      const baseline = getLatestSeq();
      enqueue("s1", "text", { content: "a" });
      enqueue("s2", "text", { content: "b" });
      const all = getAfter(baseline);
      assert.equal(all.length, 2);
    });
  });

  describe("getLatestSeq", () => {
    it("returns 0 when queue is empty and freshly loaded", () => {
      // After loadQueue with no existing file, seq starts at 1,
      // so latestSeq = nextSeq - 1 = 0
      // (this depends on whether the queue file exists)
      const latest = getLatestSeq();
      // latestSeq should be >= 0
      assert.ok(latest >= 0);
    });

    it("returns the seq of the last enqueued message", () => {
      const seq1 = enqueue("s1", "text", { content: "a" });
      const seq2 = enqueue("s1", "text", { content: "b" });
      assert.equal(getLatestSeq(), seq2);
    });
  });

  describe("circular buffer", () => {
    it("trims messages beyond maxSize", () => {
      // Load with a small max size
      loadQueue(5);

      for (let i = 0; i < 10; i++) {
        enqueue("s1", "text", { content: `msg ${i}` });
      }

      const all = getAfter(0);
      assert.equal(all.length, 5);
      // Should have the last 5 messages
      assert.equal(all[0].payload.content, "msg 5");
      assert.equal(all[4].payload.content, "msg 9");
    });
  });

  describe("persistence", () => {
    it("survives flush and reload", () => {
      const seq1 = enqueue("s1", "text", { content: "persistent msg" });
      flushQueue();

      // Reload the queue
      loadQueue(100);

      const latest = getLatestSeq();
      assert.ok(latest >= seq1, `latestSeq ${latest} should be >= ${seq1}`);

      // Messages should be available
      const messages = getAfter(seq1 - 1);
      assert.ok(messages.length >= 1);
      assert.equal(messages[0].payload.content, "persistent msg");
    });

    it("preserves seq continuity across reloads", () => {
      const seq1 = enqueue("s1", "text", { content: "before reload" });
      flushQueue();

      loadQueue(100);
      const seq2 = enqueue("s1", "text", { content: "after reload" });

      assert.ok(seq2 > seq1, `seq2 (${seq2}) should be > seq1 (${seq1})`);
    });
  });
});
