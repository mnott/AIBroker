/**
 * core/transport.ts — Shared API backend delivery with transport abstraction.
 *
 * Centralises the voice-detection, TTS chunking, and response-routing logic
 * that every transport (Whazaa, Telex, …) needs when using the APIBackend.
 * Transports only provide two callbacks: sendText and sendVoice.
 */

import type { APIBackend } from "../backend/api.js";
import { textToVoiceNote } from "../adapters/kokoro/tts.js";
import { splitIntoChunks } from "../adapters/kokoro/media.js";
import { loadVoiceConfig } from "./persistence.js";
import { stripMarkdown } from "./markdown.js";
import { log } from "./log.js";

/** Transport-provided callbacks for sending responses back to the user. */
export interface TransportCallbacks {
  /** Send a text message (already markdown-formatted by the transport). */
  sendText: (text: string) => Promise<unknown>;
  /** Send a single voice-note buffer (OGG Opus). transcript is for companion-app display. */
  sendVoice: (buffer: Buffer, transcript?: string) => Promise<unknown>;
}

/**
 * Deliver a message through the APIBackend and route the response back
 * via the appropriate transport channel (text or voice).
 *
 * Voice detection: if `message` contains `:voice]` (e.g. `[Whazaa:voice]`),
 * the response is synthesised to voice notes via Kokoro TTS and sent as
 * audio.  Otherwise it's sent as a plain text message.
 */
export async function deliverViaApi(
  backend: APIBackend,
  message: string,
  sessionId: string,
  transport: TransportCallbacks,
): Promise<void> {
  const isVoice = message.includes(":voice]");
  log(`deliverViaApi: session=${sessionId}, voice=${isVoice}`);

  try {
    const response = await backend.deliver(message, sessionId);
    if (!response) return;

    if (isVoice) {
      const voice = loadVoiceConfig().defaultVoice;
      // Strip markdown — TTS reads asterisks, backticks etc. literally
      const plainText = stripMarkdown(response);
      const chunks = splitIntoChunks(plainText);
      for (let i = 0; i < chunks.length; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, 1000));
        const audioBuffer = await textToVoiceNote(chunks[i], voice);
        await transport.sendVoice(audioBuffer, chunks[i]);
      }
      log(`deliverViaApi: voice reply sent (${chunks.length} chunk${chunks.length > 1 ? "s" : ""})`);
    } else {
      await transport.sendText(response);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`deliverViaApi: error — ${msg}`);
    await transport.sendText(`Error: ${msg}`).catch(() => {});
  }
}
