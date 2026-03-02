/**
 * Transport interface — messaging platform abstraction.
 *
 * Implemented by WhatsAppTransport (in Whazaa) and TelegramTransport (in Telex).
 * AIBroker never imports any transport SDK.
 */

/** Connection status snapshot */
export interface ConnectionStatus {
  connected: boolean;
  phoneNumber: string | null;
  selfId: string | null;
  awaitingAuth: boolean;
}

/** Generic contact entry (transport-agnostic) */
export interface ContactEntry {
  /** Transport-specific identifier (JID for WhatsApp, chatId for Telegram) */
  id: string;
  name: string | null;
  /** Optional secondary identifier (phone number, username, etc.) */
  handle?: string;
  lastSeen: number;
}

/** Incoming message callback */
export type MessageHandler = (
  text: string,
  messageId: string | number,
  timestamp: number,
) => Promise<void>;

/**
 * Transport abstraction — one implementation per messaging platform.
 */
export interface Transport {
  readonly name: string;
  readonly messagePrefix: string;
  readonly voicePrefix: string;

  connect(onMessage: MessageHandler): Promise<void>;
  disconnect(): Promise<void>;
  getStatus(): ConnectionStatus;
  sendMessage(text: string, recipient?: string): Promise<string>;
  sendFile(path: string, recipient?: string, caption?: string): Promise<void>;
  sendVoiceNote(buffer: Buffer, recipient?: string): Promise<void>;
  startTyping(recipient?: string): void;
  stopTyping(): void;
  formatMarkdown(text: string): string;
  resolveRecipient(query: string): Promise<string | null>;
}
