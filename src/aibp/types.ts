/**
 * AIBP — AIBroker Interchange Protocol
 *
 * Canonical types for the protocol. Source of truth is SPEC-aibp-protocol.md.
 * Every message has explicit src/dst addressing — no guessing.
 */

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

export type MessageType =
  | "TEXT"
  | "VOICE"
  | "IMAGE"
  | "COMMAND"
  | "SYSTEM"
  | "TYPING"
  | "STATUS"
  | "FILE";

export type SystemEvent =
  | "REGISTER"
  | "REGISTER_ACK"
  | "JOIN"
  | "JOIN_ACK"
  | "PART"
  | "PART_ACK"
  | "PING"
  | "PONG"
  | "ERROR"
  | "SHUTDOWN"
  | "OUTBOX_DRAIN"
  | "PLUGIN_OFFLINE";

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

export interface TextPayload {
  content: string;
}

export interface VoicePayload {
  audioBase64: string;
  transcript: string;
  transcriptConfidence?: number;
  durationMs?: number;
  groupId?: string;
  chunkIndex?: number;
  totalChunks?: number;
}

export interface ImagePayload {
  imageBase64: string;
  mimeType: string;
  caption?: string;
}

export interface TypingPayload {
  active: boolean;
}

export interface StatusPayload {
  subject: string;
  state: "idle" | "busy" | "error" | "disconnected";
  summary?: string;
}

export interface CommandPayload {
  command: string;
  args: Record<string, unknown>;
}

export interface SystemPayload {
  event: SystemEvent;
  [key: string]: unknown;
}

export interface FilePayload {
  filename: string;
  mimeType: string;
  dataBase64?: string;
  path?: string;
  sizeBytes?: number;
}

export type AibpPayload =
  | TextPayload
  | VoicePayload
  | ImagePayload
  | TypingPayload
  | StatusPayload
  | CommandPayload
  | SystemPayload
  | FilePayload;

// ---------------------------------------------------------------------------
// The envelope — every AIBP message has this shape
// ---------------------------------------------------------------------------

export interface AibpMessage<P extends AibpPayload = AibpPayload> {
  aibp: "0.1";
  id: string;
  ts: number;
  src: string;
  dst: string;
  type: MessageType;
  payload: P;
}

// ---------------------------------------------------------------------------
// Plugin types
// ---------------------------------------------------------------------------

export type PluginType = "transport" | "terminal" | "mobile" | "bridge" | "mcp" | "hub";

export interface CommandSpec {
  name: string;
  description: string;
  args: string;
  subcommands?: CommandSpec[];
}

export interface PluginSpec {
  id: string;
  type: PluginType;
  name: string;
  version?: string;
  capabilities: MessageType[];
  channels: string[];
  commands?: CommandSpec[];
}

export interface PluginAuth {
  token?: string;
}

// ---------------------------------------------------------------------------
// Channel membership
// ---------------------------------------------------------------------------

export interface ChannelMembership {
  channel: string;
  members: Set<string>;
  lastMessageId?: string;
  lastMessageTs?: number;
  outbox: AibpMessage[];
}

// ---------------------------------------------------------------------------
// Registered plugin (hub-side state)
// ---------------------------------------------------------------------------

export interface RegisteredPlugin {
  spec: PluginSpec;
  address: string;
  connectedAt: number;
  lastPing?: number;
  missedPings: number;
  status: "active" | "degraded" | "dead";
  joinedChannels: Set<string>;
}
