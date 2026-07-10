#!/usr/bin/env node
/**
 * aibroker-progress.mjs — PreToolUse hook (matcher: Task). Layer 2.
 *
 * When the assistant spawns a Task (research / long work) during a turn that
 * originated from PAILot, push a one-time progress note to the channel so the
 * user — e.g. driving, listening — knows the session is working and an answer
 * is coming. Without this, "I'll research this and report back" only ever
 * reaches the terminal.
 *
 * Voice turns get ONE short spoken ack (not per-tool audio spam). Text turns
 * get a text line describing the work. Fires at most once per turn.
 *
 * Always allows the tool (exit 0). Terminal turns → no-op.
 */

import {
  readStdin, parseHookInput, readTranscriptLines,
  findLastHumanPrompt, detectChannel,
  pailotDeliver, hashPrompt, claimOnce,
} from "./aibroker-hook-lib.mjs";

const VOICE_ACK = "On it — I'm working on that now and I'll speak the answer as soon as it's ready.";

async function main() {
  const input = await parseHookInput(await readStdin());
  // The subagent-spawn tool is "Task" in some harnesses, "Agent" in others.
  if (!input || (input.toolName !== "Task" && input.toolName !== "Agent") || !input.transcriptPath) return;

  const lines = readTranscriptLines(input.transcriptPath);
  if (lines.length === 0) return;

  const prompt = findLastHumanPrompt(lines);
  if (!prompt) return;

  const chan = detectChannel(prompt.blocks);
  if (!chan || chan.channel !== "pailot") return;

  // One progress signal per turn.
  const hash = hashPrompt(prompt.blocks.join("\n"));
  if (!claimOnce("progress", input.sessionId, hash)) return;

  if (chan.voice) {
    await pailotDeliver(VOICE_ACK, true);
  } else {
    const desc = typeof input.toolInput?.description === "string" && input.toolInput.description.trim()
      ? input.toolInput.description.trim()
      : "Working on your request";
    await pailotDeliver(`🔧 ${desc}… I'll report back when done.`, false);
  }
}

main().catch(() => {}).finally(() => process.exit(0));
