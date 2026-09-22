#!/usr/bin/env node
/**
 * aibroker-rename-title.mjs — PreToolUse hook (matcher: mcp__aibroker__aibroker_rename).
 *
 * Writes the /resume picker title directly into the Claude Code transcript.
 *
 * Why: the daemon's rename handler used to type `/rename <name>` into the
 * caller's own session so the title would show up in /resume. That typing
 * lands in the operator's input box mid-turn — while they are about to type
 * something themselves — and got overtyped or double-submitted as garbage.
 * Claude Code stores the title as one JSON line in the transcript, observed
 * live on 2026-09-22 in this machine's project transcripts:
 *
 *   {"type":"custom-title","customTitle":"AIBroker","sessionId":"<uuid>"}
 *
 * The daemon doesn't know the transcript path, but this hook does (from the
 * PreToolUse payload), so it appends the line here instead of typing.
 * Claude Code's own running process only reflects the new title in its
 * prompt box after a restart — the /resume picker reads the file, not the
 * live process, so this takes effect immediately for the picker.
 *
 * Always allows the tool (exit 0). Any failure is a silent no-op.
 */

import { existsSync, appendFileSync } from "node:fs";
import { readStdin, parseHookInput } from "./aibroker-hook-lib.mjs";

async function main() {
  const input = await parseHookInput(await readStdin());
  if (!input || input.toolName !== "mcp__aibroker__aibroker_rename" || !input.transcriptPath) return;

  const name = input.toolInput?.name;
  if (typeof name !== "string" || !name.trim()) return;
  if (!existsSync(input.transcriptPath)) return;

  appendFileSync(
    input.transcriptPath,
    JSON.stringify({ type: "custom-title", customTitle: name.trim(), sessionId: input.sessionId }) + "\n",
  );
}

main().catch(() => {}).finally(() => process.exit(0));
