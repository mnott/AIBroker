import "./home-guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveTranscriptTail } from "../src/daemon/manage.js";

const msg = (ts: string) => JSON.stringify({ type: "assistant", timestamp: ts });
const meta = JSON.stringify({ type: "queue-operation" });

function dir(files: Record<string, { lines: string[]; mtime: number }>): string {
  const d = mkdtempSync(join(tmpdir(), "lt-"));
  for (const [n, f] of Object.entries(files)) {
    const p = join(d, n);
    writeFileSync(p, f.lines.join("\n") + "\n");
    utimesSync(p, f.mtime, f.mtime);
  }
  return d;
}

test("stale file with newer mtime but older last message loses", () => {
  const d = dir({
    "fresh.jsonl": { lines: [msg("2026-10-02T21:12:25Z")], mtime: 1000 },
    "stale.jsonl": { lines: [msg("2026-10-02T15:55:59Z"), meta], mtime: 2000 },
  });
  assert.equal(liveTranscriptTail(d)?.file, "fresh.jsonl");
});

test("fresh file with only non-message trailing records still wins by its last message", () => {
  const d = dir({
    "fresh.jsonl": { lines: [msg("2026-10-02T21:12:25Z"), meta, meta], mtime: 1000 },
    "stale.jsonl": { lines: [msg("2026-10-02T15:55:59Z")], mtime: 2000 },
    "empty.jsonl": { lines: [meta], mtime: 3000 },
  });
  assert.equal(liveTranscriptTail(d)?.file, "fresh.jsonl");
});

test("empty folder -> none", () => {
  assert.equal(liveTranscriptTail(dir({})), null);
});
