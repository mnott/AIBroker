/**
 * MessengerAdapter — the contract every messaging adapter must fulfill.
 *
 * Adapters are independent processes. They implement this interface
 * structurally by registering IPC handlers that match these method
 * signatures. The interface exists for documentation and for the
 * adapter scaffold generator.
 */
export interface MessengerAdapter {
  readonly name: string;
  readonly displayName: string;
  readonly version: string;

  // Lifecycle
  start(config: AdapterConfig): Promise<void>;
  stop(): Promise<void>;
  health(): Promise<AdapterHealth>;

  // Auth
  login(): Promise<string>;
  connectionStatus(): Promise<AdapterConnectionStatus>;

  // Outbound (hub -> upstream)
  sendText(text: string, recipient?: string): Promise<void>;
  sendVoice(audioPath: string, recipient?: string): Promise<void>;
  sendFile(filePath: string, caption?: string, mimetype?: string, recipient?: string): Promise<void>;
  sendImage(imagePath: string, caption?: string, recipient?: string): Promise<void>;
}

export interface AdapterConfig {
  appDir: string;
  socketPath: string;
  hubSocketPath: string;
  settings: Record<string, unknown>;
}

export type AdapterConnectionStatus = "connected" | "connecting" | "disconnected" | "error";

export interface AdapterHealth {
  status: "ok" | "degraded" | "down";
  connectionStatus: AdapterConnectionStatus;
  stats: {
    messagesReceived: number;
    messagesSent: number;
    errors: number;
  };
  lastMessageAgo: number | null;
  detail?: string;
}
