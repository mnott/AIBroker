/**
 * test/markdown.test.ts — Unit tests for markdown transforms.
 *
 * Run: npx tsx --test test/markdown.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { markdownToWhatsApp, stripMarkdown } from "../src/core/markdown.js";

describe("markdownToWhatsApp", () => {
  it("converts headings to bold uppercase", () => {
    assert.equal(markdownToWhatsApp("# Hello"), "*HELLO*");
    assert.equal(markdownToWhatsApp("## Sub Heading"), "*SUB HEADING*");
    assert.equal(markdownToWhatsApp("### Third"), "*THIRD*");
  });

  it("converts bold to WhatsApp bold", () => {
    assert.equal(markdownToWhatsApp("**bold text**"), "*bold text*");
  });

  it("converts italic to WhatsApp italic", () => {
    assert.equal(markdownToWhatsApp("*italic text*"), "_italic text_");
  });

  it("converts horizontal rules to em dashes", () => {
    assert.equal(markdownToWhatsApp("---"), "———");
    assert.equal(markdownToWhatsApp("-----"), "———");
  });

  it("converts blockquotes to left bar", () => {
    assert.equal(markdownToWhatsApp("> quoted text"), "▎ quoted text");
  });

  it("converts checkboxes to unicode", () => {
    assert.equal(markdownToWhatsApp("- [x] done"), "☑ done");
    assert.equal(markdownToWhatsApp("- [ ] todo"), "☐ todo");
  });

  it("converts unordered lists to bullets", () => {
    assert.equal(markdownToWhatsApp("- item one"), "• item one");
    assert.equal(markdownToWhatsApp("* item two"), "• item two");
  });

  it("converts inline code to triple backticks", () => {
    assert.equal(markdownToWhatsApp("`code`"), "```code```");
  });

  it("preserves plain text", () => {
    assert.equal(markdownToWhatsApp("hello world"), "hello world");
  });
});

describe("stripMarkdown", () => {
  it("strips headings", () => {
    assert.equal(stripMarkdown("# Title"), "Title");
    assert.equal(stripMarkdown("## Subtitle"), "Subtitle");
  });

  it("strips bold", () => {
    assert.equal(stripMarkdown("**bold**"), "bold");
  });

  it("strips italic with asterisks", () => {
    assert.equal(stripMarkdown("*italic*"), "italic");
  });

  it("strips italic with underscores", () => {
    assert.equal(stripMarkdown("_italic_"), "italic");
  });

  it("strips inline code", () => {
    assert.equal(stripMarkdown("`code`"), "code");
  });

  it("strips links", () => {
    assert.equal(stripMarkdown("[click here](https://example.com)"), "click here");
  });

  it("strips blockquotes", () => {
    assert.equal(stripMarkdown("> quoted"), "quoted");
  });

  it("strips horizontal rules", () => {
    assert.equal(stripMarkdown("---"), "");
  });

  it("strips checkboxes", () => {
    assert.equal(stripMarkdown("- [x] done").trim(), "done");
    assert.equal(stripMarkdown("- [ ] todo").trim(), "todo");
  });

  it("strips list markers", () => {
    assert.equal(stripMarkdown("- item").trim(), "item");
  });

  it("preserves plain text", () => {
    assert.equal(stripMarkdown("hello world"), "hello world");
  });

  it("collapses multiple blank lines", () => {
    const input = "line 1\n\n\n\nline 2";
    assert.equal(stripMarkdown(input), "line 1\n\nline 2");
  });
});
