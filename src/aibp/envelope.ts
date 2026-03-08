/**
 * AIBP envelope utilities — create, parse, and validate AIBP messages.
 */

import { randomUUID } from "node:crypto";
import type {
  AibpMessage,
  AibpPayload,
  CommandPayload,
  ImagePayload,
  MessageType,
  StatusPayload,
  SystemEvent,
  SystemPayload,
  TextPayload,
  TypingPayload,
  VoicePayload,
} from "./types.js";

const AIBP_VERSION = "0.1" as const;

// ---------------------------------------------------------------------------
// Factory — create typed messages with automatic envelope fields
// ---------------------------------------------------------------------------

function envelope<P extends AibpPayload>(
  src: string,
  dst: string,
  type: MessageType,
  payload: P,
): AibpMessage<P> {
  return {
    aibp: AIBP_VERSION,
    id: randomUUID(),
    ts: Date.now(),
    src,
    dst,
    type,
    payload,
  };
}

export function text(src: string, dst: string, content: string): AibpMessage<TextPayload> {
  return envelope(src, dst, "TEXT", { content });
}

export function voice(
  src: string,
  dst: string,
  audioBase64: string,
  transcript: string,
  durationMs?: number,
): AibpMessage<VoicePayload> {
  return envelope(src, dst, "VOICE", { audioBase64, transcript, durationMs });
}

export function image(
  src: string,
  dst: string,
  imageBase64: string,
  mimeType: string,
  caption?: string,
): AibpMessage<ImagePayload> {
  return envelope(src, dst, "IMAGE", { imageBase64, mimeType, caption });
}

export function typing(src: string, dst: string, active: boolean): AibpMessage<TypingPayload> {
  return envelope(src, dst, "TYPING", { active });
}

export function status(
  src: string,
  dst: string,
  subject: string,
  state: StatusPayload["state"],
  summary?: string,
): AibpMessage<StatusPayload> {
  return envelope(src, dst, "STATUS", { subject, state, summary });
}

export function command(
  src: string,
  dst: string,
  cmd: string,
  args: Record<string, unknown> = {},
): AibpMessage<CommandPayload> {
  return envelope(src, dst, "COMMAND", { command: cmd, args });
}

export function system(
  src: string,
  dst: string,
  event: SystemEvent,
  data: Record<string, unknown> = {},
): AibpMessage<SystemPayload> {
  return envelope(src, dst, "SYSTEM", { event, ...data });
}

// ---------------------------------------------------------------------------
// Parsing — validate incoming JSON
// ---------------------------------------------------------------------------

export function parse(raw: string): AibpMessage | null {
  try {
    const obj = JSON.parse(raw);
    if (!isAibpMessage(obj)) return null;
    return obj;
  } catch {
    return null;
  }
}

export function isAibpMessage(obj: unknown): obj is AibpMessage {
  if (typeof obj !== "object" || obj === null) return false;
  const m = obj as Record<string, unknown>;
  return (
    typeof m.aibp === "string" &&
    typeof m.id === "string" &&
    typeof m.ts === "number" &&
    typeof m.src === "string" &&
    typeof m.dst === "string" &&
    typeof m.type === "string" &&
    typeof m.payload === "object" &&
    m.payload !== null
  );
}

// ---------------------------------------------------------------------------
// Serialize — NDJSON line
// ---------------------------------------------------------------------------

export function serialize(msg: AibpMessage): string {
  return JSON.stringify(msg) + "\n";
}

// ---------------------------------------------------------------------------
// Address helpers
// ---------------------------------------------------------------------------

/** Extract the address type prefix (e.g., "session" from "session:ABC123") */
export function addressType(address: string): string {
  const colon = address.indexOf(":");
  return colon > 0 ? address.slice(0, colon) : address;
}

/** Extract the address value (e.g., "ABC123" from "session:ABC123") */
export function addressValue(address: string): string {
  const colon = address.indexOf(":");
  return colon > 0 ? address.slice(colon + 1) : address;
}

/** Check if an address is a hub-local address (not a remote hub reference) */
export function isLocal(address: string): boolean {
  return !address.includes("/");
}

/** For mesh addresses like "hub:mac-mini/session:DEF456", extract the hub and local parts */
export function parseMeshAddress(address: string): { hub: string; local: string } | null {
  const slash = address.indexOf("/");
  if (slash < 0) return null;
  return {
    hub: address.slice(0, slash),
    local: address.slice(slash + 1),
  };
}
