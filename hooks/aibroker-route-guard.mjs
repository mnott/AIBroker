#!/usr/bin/env node
/**
 * aibroker-route-guard.mjs — Stop hook. Layer 1 of bulletproof channel routing.
 *
 * When a turn ends, inspect the triggering prompt. If it came from a channel
 * (starts with [PAILot] / [PAILot:voice]) but the matching reply tool was NOT
 * called during the turn, the answer went only to the terminal — a routing
 * miss. This guard then delivers the final answer to the channel itself over
 * the existing pailot_send IPC, so a voice question can never get zero answer.
 *
 * Scope: PAILot (text + voice). Whazaa/Telex replies need recipient context the
 * hook doesn't have, so they are detected but left to the normal flow.
 *
 * Fails safe: any error → exit 0, no delivery. Terminal turns → no-op.
 */

import {
  readStdin, parseHookInput, readTranscriptLines,
  findLastHumanPrompt, detectChannel, scanReplyTools, lastAssistantText,
  pailotDeliver, hashPrompt, claimOnce,
} from "./aibroker-hook-lib.mjs";

const DEBUG = process.env.AIBROKER_HOOK_DEBUG === "1";
const dbg = (m) => { if (DEBUG) console.error(`[route-guard] ${m}`); };

async function main() {
  const input = await parseHookInput(await readStdin());
  if (!input || !input.transcriptPath) return;

  const lines = readTranscriptLines(input.transcriptPath);
  if (lines.length === 0) return;

  const prompt = findLastHumanPrompt(lines);
  if (!prompt) { dbg("no human prompt"); return; }

  const chan = detectChannel(prompt.blocks);
  if (!chan) { dbg("terminal turn — no prefix, no-op"); return; }

  // Only PAILot is auto-deliverable (self-resolving session). Others: leave be.
  if (chan.channel !== "pailot") { dbg(`channel ${chan.channel} out of scope`); return; }

  const { tts, send } = scanReplyTools(lines, prompt.index);
  // voice-in requires voice-out (pailot_tts). text-in is satisfied by either.
  const answered = chan.voice ? tts : (send || tts);
  if (answered) { dbg("already answered on channel — no-op"); return; }

  const answer = lastAssistantText(lines, prompt.index);
  if (!answer) { dbg("no assistant text to deliver"); return; }

  // Fire at most once per turn.
  const hash = hashPrompt(prompt.blocks.join("\n"));
  if (!claimOnce("guard", input.sessionId, hash)) { dbg("already delivered this turn"); return; }

  const res = await pailotDeliver(answer, chan.voice);
  if (res?.ok) {
    console.error(`[route-guard] recovered routing miss → delivered answer to PAILot${chan.voice ? " (voice)" : ""}.`);
  } else {
    dbg(`delivery failed: ${res?.error ?? "unknown"}`);
  }
}

main().catch(() => {}).finally(() => process.exit(0));
