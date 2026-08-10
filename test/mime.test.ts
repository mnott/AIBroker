/**
 * test/mime.test.ts — Unit tests for MIME type lookup.
 *
 * Run: npx tsx --test test/mime.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { lookupMime, extForMime, MIME_MAP } from "../src/core/mime.js";

describe("lookupMime", () => {
  it("looks up common document types", () => {
    assert.equal(lookupMime(".pdf"), "application/pdf");
    assert.equal(lookupMime(".json"), "application/json");
    assert.equal(lookupMime(".txt"), "text/plain");
    assert.equal(lookupMime(".csv"), "text/csv");
  });

  it("looks up image types", () => {
    assert.equal(lookupMime(".jpg"), "image/jpeg");
    assert.equal(lookupMime(".jpeg"), "image/jpeg");
    assert.equal(lookupMime(".png"), "image/png");
    assert.equal(lookupMime(".gif"), "image/gif");
    assert.equal(lookupMime(".webp"), "image/webp");
    assert.equal(lookupMime(".svg"), "image/svg+xml");
  });

  it("looks up audio types", () => {
    assert.equal(lookupMime(".mp3"), "audio/mpeg");
    assert.equal(lookupMime(".ogg"), "audio/ogg");
    assert.equal(lookupMime(".m4a"), "audio/mp4");
    assert.equal(lookupMime(".wav"), "audio/wav");
  });

  it("looks up video types", () => {
    assert.equal(lookupMime(".mp4"), "video/mp4");
    assert.equal(lookupMime(".mov"), "video/quicktime");
    assert.equal(lookupMime(".mkv"), "video/x-matroska");
  });

  it("handles extension without leading dot", () => {
    assert.equal(lookupMime("pdf"), "application/pdf");
    assert.equal(lookupMime("png"), "image/png");
    assert.equal(lookupMime("mp3"), "audio/mpeg");
  });

  it("normalizes case", () => {
    assert.equal(lookupMime(".PDF"), "application/pdf");
    assert.equal(lookupMime(".JPG"), "image/jpeg");
    assert.equal(lookupMime("PNG"), "image/png");
  });

  it("returns octet-stream for unknown extensions", () => {
    assert.equal(lookupMime(".xyz"), "application/octet-stream");
    assert.equal(lookupMime(".unknown"), "application/octet-stream");
    assert.equal(lookupMime("nope"), "application/octet-stream");
  });
});

describe("extForMime", () => {
  it("names a video what it is", () => {
    // The failure this exists to stop: a video saved as `.bin`, which arrives
    // on a phone unplayable until renamed by hand.
    assert.equal(extForMime("video/mp4"), "mp4");
    assert.equal(extForMime("video/quicktime"), "mov");
  });

  it("round-trips every type the table accepts", () => {
    // Anything this codebase is willing to SEND it must also be able to NAME.
    // Both places that answered this question locally listed a few types they
    // had thought of and called the rest "bin".
    for (const [ext, mime] of Object.entries(MIME_MAP)) {
      const back = extForMime(mime);
      assert.equal(lookupMime(back), mime, `${ext} -> ${mime} -> .${back} did not come back`);
    }
  });

  it("ignores parameters and case", () => {
    assert.equal(extForMime("VIDEO/MP4"), "mp4");
    assert.equal(extForMime("text/plain; charset=utf-8"), "txt");
  });

  it("takes a self-naming subtype for a type it does not carry", () => {
    assert.equal(extForMime("image/heic"), "heic");
  });

  it("falls back to bin only when nothing else is honest", () => {
    assert.equal(extForMime("application/octet-stream"), "bin");
    assert.equal(extForMime(""), "bin");
  });
});

describe("MIME_MAP", () => {
  it("has entries for all major categories", () => {
    const values = Object.values(MIME_MAP);
    assert.ok(values.some(v => v.startsWith("application/")));
    assert.ok(values.some(v => v.startsWith("image/")));
    assert.ok(values.some(v => v.startsWith("audio/")));
    assert.ok(values.some(v => v.startsWith("video/")));
    assert.ok(values.some(v => v.startsWith("text/")));
  });

  it("all keys start with a dot", () => {
    for (const key of Object.keys(MIME_MAP)) {
      assert.ok(key.startsWith("."), `Expected "${key}" to start with "."`);
    }
  });
});
