/**
 * daemon/command-context.ts — Reply abstraction for hub commands.
 *
 * Commands executed by the AIBroker hub need to send responses back to the
 * user through the originating adapter (WhatsApp, Telegram, etc.). Instead
 * of calling transport-specific functions directly, commands receive a
 * CommandContext that abstracts the reply channel.
 *
 * The hub creates a CommandContext for each incoming message, wiring `reply`,
 * `replyImage`, and `replyVoice` through the adapter registry's delivery mechanism.
 */

export interface CommandContext {
  /** Send a text reply back through the originating adapter. */
  reply: (text: string) => Promise<void>;

  /** Send an image reply (screenshot etc.) back through the originating adapter. */
  replyImage: (buffer: Buffer, caption: string) => Promise<void>;

  /** Send a voice note reply back through the originating adapter. */
  replyVoice: (audioBuffer: Buffer, caption: string) => Promise<void>;

  /** Send a typing/busy indicator to the originating client. */
  typing: (active: boolean) => void;

  /** The adapter that originated the message ("whazaa", "telex", "pailot"). */
  source: string;

  /** External recipient identifier (phone JID, chat ID) if known. */
  recipient?: string;

  /** The active iTerm/Claude session ID, if known. Used for image context scoping. */
  sessionId?: string;
}
