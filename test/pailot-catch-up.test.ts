/**
 * A catch-up reply a phone can actually receive.
 *
 * The failure being prevented is self-sustaining, which is why it is worth
 * pinning: a client asks from its last sequence, the reply is too large to
 * take, the socket dies partway, and the client reconnects and asks from the
 * SAME sequence — so it is handed the identical payload for as long as it stays
 * on the network. Observed as connect, reply, ECONNRESET, repeat.
 *
 * The two limits are separate on purpose and both are tested: a total cap
 * cannot bound a single huge message, because it must always admit the first
 * one rather than return nothing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCatchUp } from "../src/adapters/pailot/gateway.js";

/** A queue entry of roughly the given payload size. */
function entry(payload: Record<string, unknown>) {
  return { payload };
}

/** A base64-ish blob of about n bytes. */
function blob(n: number): string {
  return "A".repeat(n);
}

test("a small batch passes through whole", () => {
  const r = buildCatchUp([entry({ type: "text", content: "one" }), entry({ type: "text", content: "two" })]);
  assert.equal(r.messages.length, 2);
  assert.equal(r.withheld, 0);
  assert.equal(r.lightened, 0);
  assert.equal((r.messages[0] as Record<string, unknown>).content, "one");
});

test("order is preserved — oldest first — even though trimming works backwards", () => {
  const r = buildCatchUp([entry({ content: "a" }), entry({ content: "b" }), entry({ content: "c" })]);
  assert.deepEqual(r.messages.map((m) => (m as Record<string, unknown>).content), ["a", "b", "c"]);
});

test("voice becomes text and loses its audio, since audio cannot be replayed", () => {
  const r = buildCatchUp([entry({ type: "voice", audioBase64: blob(5000), transcript: "hello there" })]);
  const m = r.messages[0] as Record<string, unknown>;
  assert.equal(m.type, "text");
  assert.equal(m.audioBase64, undefined);
  assert.equal(m.content, "hello there");
});

test("one oversized message is kept but stripped, and says what was omitted", () => {
  // This is the case the total cap cannot catch: it always admits the first.
  const r = buildCatchUp([entry({ type: "image", imageBase64: blob(600 * 1024), caption: "a page" })]);
  const m = r.messages[0] as Record<string, unknown>;
  assert.equal(r.messages.length, 1, "the message survives");
  assert.equal(m.imageBase64, undefined, "its weight does not");
  assert.equal(m.omitted, "imageBase64", "and it says so");
  assert.equal(m.caption, "a page", "the rest is untouched");
  assert.equal(r.lightened, 1);
  assert.ok(r.bytes < 256 * 1024, `bytes should be small, got ${r.bytes}`);
});

test("a reply is never allowed to grow past the total cap", () => {
  // Fifty messages just under the per-message limit would be ~12 MB unbounded.
  const many = Array.from({ length: 50 }, (_, i) => entry({ content: blob(200 * 1024), n: i }));
  const r = buildCatchUp(many);
  assert.ok(r.bytes <= 4 * 1024 * 1024, `bytes ${r.bytes} over cap`);
  assert.ok(r.withheld > 0, "and it reports what it left out");
  assert.ok(r.messages.length < 50);
});

test("when trimming, the newest are the ones kept", () => {
  const many = Array.from({ length: 40 }, (_, i) => entry({ content: blob(200 * 1024), n: i }));
  const r = buildCatchUp(many);
  const kept = r.messages.map((m) => (m as Record<string, unknown>).n as number);
  assert.equal(kept[kept.length - 1], 39, "the most recent message is present");
  assert.ok(kept[0] > 0, "and the oldest were the ones dropped");
});

test("a stripped image with no caption is given words, so it is not dropped", () => {
  // The app skips any message with neither text nor image data, so without
  // this an uncaptioned picture would vanish from the history entirely.
  const r = buildCatchUp([entry({ type: "image", imageBase64: blob(600 * 1024) })]);
  const m = r.messages[0] as Record<string, unknown>;
  assert.equal(m.omitted, "imageBase64");
  assert.ok(typeof m.content === "string" && (m.content as string).length > 0, "it says something");
});

test("a stripped image that already had a caption keeps the caption", () => {
  const r = buildCatchUp([entry({ type: "image", imageBase64: blob(600 * 1024), caption: "page 4" })]);
  const m = r.messages[0] as Record<string, unknown>;
  assert.equal(m.caption, "page 4");
  assert.equal(m.content, undefined, "no invented text over the operator's own");
});

test("an empty batch is empty, not an error", () => {
  const r = buildCatchUp([]);
  assert.deepEqual(r.messages, []);
  assert.equal(r.bytes, 0);
  assert.equal(r.withheld, 0);
});

test("the source payloads are not modified — the queue keeps its attachments", () => {
  // The queue is the record; a replay must not strip what it holds, or the
  // image is gone for every later reader too.
  const original = { type: "image", imageBase64: blob(600 * 1024) };
  buildCatchUp([entry(original)]);
  assert.equal(typeof original.imageBase64, "string");
  assert.equal(original.imageBase64.length, 600 * 1024);
});
