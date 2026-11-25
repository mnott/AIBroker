#!/usr/bin/env node
/**
 * hooks/voice-reply.mjs — remind a session that it asked to be answered in voice.
 *
 * A session sets replyInVoice via aibroker_voice_config; from then on every
 * prompt should get a short reminder to answer by calling aibroker_speak rather
 * than writing text. The setting lives per-session in the daemon, so this hook
 * only reads it: voice_config get with session "self".
 *
 * Silent on everything else: daemon down, no setting, worker child (PAI_WORKER),
 * or a prompt that came from another channel ([PAILot / [Whazaa / [Telex] —
 * those already have their own reply path and must not be double-answered.
 */

import { ipcCall } from "./aibroker-hook-lib.mjs";

if (process.env.PAI_WORKER === "1") process.exit(0);

let prompt = "";
try {
  if (!process.stdin.isTTY) {
    let buf = "";
    const read = (async () => { for await (const c of process.stdin) buf += c; })();
    await Promise.race([read, new Promise((r) => setTimeout(r, 300))]);
    prompt = JSON.parse(buf)?.prompt ?? "";
  }
} catch { /* payload unreadable: no prefix to check */ }

// Channel-delivered prompts have their own reply route; a voice reminder here
// would make the session answer the same message twice.
if (/^\s*\[(PAILot|Whazaa|Telex)(:voice)?\]/i.test(prompt)) process.exit(0);

const r = await ipcCall("voice_config", { action: "get", session: "self" });
if (!r?.ok || !r.result?.session?.replyInVoice) process.exit(0);

const speed = typeof r.result.session.speed === "number" ? r.result.session.speed : 1;
const text =
  `This session is set to reply in voice (speed ${speed}). Answer by calling aibroker_speak: ` +
  `keep the spoken answer concise (a few sentences); give full detail only if asked. ` +
  `Set replyInVoice:false with aibroker_voice_config to go back to text.`;

process.stdout.write(
  JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text } }) + "\n",
);
