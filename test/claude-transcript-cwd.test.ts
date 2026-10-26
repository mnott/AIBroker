import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transcriptCwd } from "../src/core/claude-transcript-cwd.js";

const UUID = "0a1b2c3d-1111-2222-3333-444455556666";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "tcwd-"));
  mkdirSync(join(root, "-proj-a"));
  mkdirSync(join(root, "-proj-b"));
  writeFileSync(join(root, "-proj-b", `${UUID}.jsonl`),
    '{"type":"summary"}\nnot json "cwd"\n{"type":"user","cwd":"/work/leaf"}\n{"cwd":"/elsewhere"}\n');
  return root;
}

test("finds the first cwd by full uuid", () => {
  const root = fixture();
  try { assert.equal(transcriptCwd(UUID, root), "/work/leaf"); } finally { rmSync(root, { recursive: true }); }
});

test("finds it by uuid prefix", () => {
  const root = fixture();
  try { assert.equal(transcriptCwd("0a1b2c3d", root), "/work/leaf"); } finally { rmSync(root, { recursive: true }); }
});

test("unknown uuid or missing dir gives null", () => {
  const root = fixture();
  try {
    assert.equal(transcriptCwd("ffffffff-0000", root), null);
    assert.equal(transcriptCwd(UUID, join(root, "nope")), null);
  } finally { rmSync(root, { recursive: true }); }
});

test("answer is cached per uuid", () => {
  const root = fixture();
  assert.equal(transcriptCwd(UUID, root), "/work/leaf");
  rmSync(root, { recursive: true });
  assert.equal(transcriptCwd(UUID, root), "/work/leaf");
});
