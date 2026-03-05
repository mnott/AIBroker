/**
 * types/broker.ts — Unified message format for hub routing.
 *
 * BrokerMessage is the canonical envelope that flows between the hub
 * and adapters. Every message routed through the hub is wrapped in
 * this format, regardless of the originating transport (WhatsApp,
 * Telegram, PAILot, etc.).
 */

import { randomUUID } from "node:crypto";

export type BrokerMessageType = "text" | "voice" | "image" | "video" | "file" | "command" | "status";

export interface BrokerMessagePayload {
  text?: string;
  filePath?: string;
  /** Path to audio file on disk (for voice messages). */
  audioPath?: string;
  /** Base64-encoded binary data (for voice/file over JSON IPC). */
  buffer?: string;
  mimetype?: string;
  caption?: string;
  /** External recipient identifier (phone number, chat ID, JID). */
  recipient?: string;
  /** Channel hint for adapter-level routing ("pailot", "whatsapp"). */
  channel?: string;
  /** Adapter-specific extras. */
  metadata?: Record<string, unknown>;
}

export interface BrokerMessage {
  id: string;
  timestamp: number;
  /** Adapter that originated the message. */
  source: string;
  /** Target adapter name. Omit for default routing. */
  target?: string;
  type: BrokerMessageType;
  payload: BrokerMessagePayload;
}

export interface RouteResult {
  ok: boolean;
  /** Which adapter handled the delivery. */
  deliveredTo?: string;
  /** Error description if routing or delivery failed. */
  error?: string;
  /** Result payload from the adapter's deliver handler. */
  adapterResult?: Record<string, unknown>;
}

/** Create a BrokerMessage with sensible defaults. */
export function createBrokerMessage(
  source: string,
  type: BrokerMessageType,
  payload: BrokerMessagePayload,
  target?: string,
): BrokerMessage {
  return {
    id: randomUUID(),
    timestamp: Date.now(),
    source,
    target,
    type,
    payload,
  };
}
