import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveWhisperBin, WHISPER_BIN } from "../src/index.js";
import { resolveBin } from "../src/core/bins.js";
import { appendPrivate, tightenLog } from "../src/core/private-file.js";

test("resolveWhisperBin finds a binary that appears on PATH after import", () => {
  const dir = mkdtempSync(join(tmpdir(), "bins-"));
  const savedPath = process.env.PATH;
  const savedOverride = process.env.AIBROKER_WHISPER_BIN;
  delete process.env.AIBROKER_WHISPER_BIN;
  try {
    process.env.PATH = dir;
    const before = resolveWhisperBin();
    const frozen = WHISPER_BIN; // evaluated at import, before the binary existed
    const bin = join(dir, "whisper");
    writeFileSync(bin, "#!/bin/sh\n");
    chmodSync(bin, 0o755);
    if (before === "whisper") {
      assert.equal(resolveWhisperBin(), bin);
      assert.notEqual(frozen, bin);
    } else {
      assert.ok(before.endsWith("/whisper")); // a real install shadows the fake; still resolved
    }
  } finally {
    process.env.PATH = savedPath;
    if (savedOverride !== undefined) process.env.AIBROKER_WHISPER_BIN = savedOverride;
  }
});

test("resolveBin('claude') finds a claude on PATH; AIBROKER_CLAUDE_BIN wins", () => {
  const dir = mkdtempSync(join(tmpdir(), "bins-"));
  const savedPath = process.env.PATH;
  const savedOverride = process.env.AIBROKER_CLAUDE_BIN;
  delete process.env.AIBROKER_CLAUDE_BIN;
  try {
    process.env.PATH = dir;
    const bin = join(dir, "claude");
    writeFileSync(bin, "#!/bin/sh\n");
    chmodSync(bin, 0o755);
    // a real install in ~/.local/bin or /opt/homebrew/bin legitimately shadows the fake
    assert.ok(resolveBin("claude").endsWith("/claude"));
    const override = join(dir, "override-claude");
    writeFileSync(override, "");
    process.env.AIBROKER_CLAUDE_BIN = override;
    assert.equal(resolveBin("claude"), override);
  } finally {
    process.env.PATH = savedPath;
    if (savedOverride !== undefined) process.env.AIBROKER_CLAUDE_BIN = savedOverride;
    else delete process.env.AIBROKER_CLAUDE_BIN;
  }
});

test("AIBROKER_WHISPER_BIN override wins when it exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "bins-"));
  const bin = join(dir, "w");
  writeFileSync(bin, "");
  process.env.AIBROKER_WHISPER_BIN = bin;
  try { assert.equal(resolveWhisperBin(), bin); } finally { delete process.env.AIBROKER_WHISPER_BIN; }
});

test("log files are 0600 on create and re-tightened when they pre-exist as 0644", () => {
  const dir = mkdtempSync(join(tmpdir(), "logs-"));
  const fresh = join(dir, "fresh.log");
  appendPrivate(fresh, "x\n");
  assert.equal(statSync(fresh).mode & 0o777, 0o600);

  const old = join(dir, "old.log");
  writeFileSync(old, "y\n");
  chmodSync(old, 0o644);
  appendPrivate(old, "z\n");
  assert.equal(statSync(old).mode & 0o777, 0o600);

  const t = join(dir, "t.log");
  writeFileSync(t, "");
  chmodSync(t, 0o644);
  tightenLog(t);
  assert.equal(statSync(t).mode & 0o777, 0o600);
});
