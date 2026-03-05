/**
 * test/media.test.ts — Unit tests for media utility functions.
 *
 * Run: npx tsx --test test/media.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { mimetypeToExt, mimetypeToDocExt, splitIntoChunks } from "../src/adapters/kokoro/media.js";

describe("mimetypeToExt", () => {
  it("returns jpg for null/undefined", () => {
    assert.equal(mimetypeToExt(null), "jpg");
    assert.equal(mimetypeToExt(undefined), "jpg");
  });

  it("maps image MIME types", () => {
    assert.equal(mimetypeToExt("image/png"), "png");
    assert.equal(mimetypeToExt("image/webp"), "webp");
    assert.equal(mimetypeToExt("image/gif"), "gif");
    assert.equal(mimetypeToExt("image/jpeg"), "jpg");
  });

  it("defaults to jpg for unknown types", () => {
    assert.equal(mimetypeToExt("image/bmp"), "jpg");
    assert.equal(mimetypeToExt("application/octet-stream"), "jpg");
  });
});

describe("mimetypeToDocExt", () => {
  it("returns bin for null/undefined", () => {
    assert.equal(mimetypeToDocExt(null), "bin");
    assert.equal(mimetypeToDocExt(undefined), "bin");
  });

  it("maps document MIME types", () => {
    assert.equal(mimetypeToDocExt("application/pdf"), "pdf");
    assert.equal(mimetypeToDocExt("application/json"), "json");
    assert.equal(mimetypeToDocExt("text/plain"), "txt");
    assert.equal(mimetypeToDocExt("text/csv"), "csv");
  });

  it("maps Office MIME types", () => {
    assert.equal(mimetypeToDocExt("application/vnd.openxmlformats-officedocument.wordprocessingml.document"), "docx");
    // "msword" contains "word" so the "word" check matches first → "docx"
    assert.equal(mimetypeToDocExt("application/msword"), "docx");
    assert.equal(mimetypeToDocExt("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"), "xlsx");
    assert.equal(mimetypeToDocExt("application/vnd.ms-excel"), "xls");
    assert.equal(mimetypeToDocExt("application/vnd.openxmlformats-officedocument.presentationml.presentation"), "pptx");
    assert.equal(mimetypeToDocExt("application/vnd.ms-powerpoint"), "ppt");
  });

  it("maps media MIME types", () => {
    assert.equal(mimetypeToDocExt("video/mp4"), "mp4");
    assert.equal(mimetypeToDocExt("video/webm"), "webm");
    assert.equal(mimetypeToDocExt("video/3gpp"), "3gp");
  });

  it("maps archive types", () => {
    assert.equal(mimetypeToDocExt("application/zip"), "zip");
  });

  it("returns bin for unknown types", () => {
    assert.equal(mimetypeToDocExt("application/octet-stream"), "bin");
    assert.equal(mimetypeToDocExt("something/weird"), "bin");
  });
});

describe("splitIntoChunks", () => {
  it("returns single-element array for short text", () => {
    const result = splitIntoChunks("Hello world", 500);
    assert.deepEqual(result, ["Hello world"]);
  });

  it("returns text as-is when exactly at limit", () => {
    const text = "a".repeat(500);
    const result = splitIntoChunks(text, 500);
    assert.deepEqual(result, [text]);
  });

  it("splits at paragraph boundaries", () => {
    const text = "Paragraph one.\n\nParagraph two.\n\nParagraph three.";
    const result = splitIntoChunks(text, 30);
    assert.ok(result.length >= 2);
    assert.ok(result.every(c => c.length <= 30));
  });

  it("splits long paragraphs at sentence boundaries", () => {
    const text = "First sentence. Second sentence. Third sentence. Fourth sentence.";
    const result = splitIntoChunks(text, 40);
    assert.ok(result.length >= 2);
    assert.ok(result.every(c => c.length <= 40));
  });

  it("splits very long sentences at word boundaries", () => {
    const words = Array.from({ length: 50 }, (_, i) => `word${i}`).join(" ");
    const result = splitIntoChunks(words, 50);
    assert.ok(result.length >= 2);
    assert.ok(result.every(c => c.length <= 50));
  });

  it("preserves all content after splitting", () => {
    const text = "Hello world. This is a test. Another sentence here.";
    const result = splitIntoChunks(text, 30);
    const joined = result.join(" ");
    // All words should be present
    for (const word of ["Hello", "world", "test", "Another", "sentence"]) {
      assert.ok(joined.includes(word), `Missing word: ${word}`);
    }
  });

  it("handles text with no natural break points", () => {
    const text = "abcdefghijklmnopqrstuvwxyz";
    const result = splitIntoChunks(text, 10);
    // Single word can't be split further, may exceed limit
    assert.ok(result.length >= 1);
  });

  it("uses default maxChars of 500", () => {
    const text = "a".repeat(400);
    const result = splitIntoChunks(text);
    assert.deepEqual(result, [text]);
  });
});
