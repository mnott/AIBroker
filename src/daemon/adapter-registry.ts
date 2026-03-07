/**
 * daemon/adapter-registry.ts — Registry of connected adapters + routing engine.
 *
 * Phase 1: minimal adapter tracking and commandHandler dispatch.
 * Phase 2: full BrokerMessage routing with hub -> adapter delivery via IPC.
 */

import { commandHandler } from "../core/state.js";
import { log } from "../core/log.js";
import { WatcherClient } from "../ipc/client.js";
import { createBrokerMessage } from "../types/broker.js";
import type { BrokerMessage, RouteResult } from "../types/broker.js";
import type { AdapterHealth } from "../types/adapter.js";
import { validateAdapterHealth } from "../ipc/validate.js";
import type { CommandContext } from "./command-context.js";
import { broadcastText, broadcastImage, broadcastVoice } from "../adapters/pailot/gateway.js";

export interface AdapterDescriptor {
  name: string;       // "whazaa", "telex", "pailot"
  socketPath: string; // adapter's own IPC socket (for reverse calls)
  registeredAt: number;
}

const HEALTH_TIMEOUT_MS = 5_000;

type HubCommandHandler = (text: string, timestamp: number, ctx: CommandContext) => void | Promise<void>;

export class AdapterRegistry {
  private readonly adapters = new Map<string, AdapterDescriptor>();
  private readonly lastHealth = new Map<string, AdapterHealth>();
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private hubCommandHandler: HubCommandHandler | null = null;

  setCommandHandler(handler: HubCommandHandler): void {
    this.hubCommandHandler = handler;
  }

  register(descriptor: AdapterDescriptor): void {
    this.adapters.set(descriptor.name, descriptor);
    log(`Adapter registered: ${descriptor.name} (socket: ${descriptor.socketPath})`);
  }

  unregister(name: string): void {
    this.adapters.delete(name);
    this.lastHealth.delete(name);
    log(`Adapter unregistered: ${name}`);
  }

  // ── Health Polling ──

  startHealthPolling(intervalMs: number = 60_000): void {
    if (this.pollInterval !== null) return;
    log(`[hub] health polling started (interval: ${intervalMs}ms)`);
    this.pollInterval = setInterval(() => { void this.pollAllAdapters(); }, intervalMs);
  }

  stopHealthPolling(): void {
    if (this.pollInterval === null) return;
    clearInterval(this.pollInterval);
    this.pollInterval = null;
    log(`[hub] health polling stopped`);
  }

  getAdapterHealth(name: string): AdapterHealth | undefined {
    return this.lastHealth.get(name);
  }

  getAllHealth(): Map<string, AdapterHealth> {
    return new Map(this.lastHealth);
  }

  private async pollAllAdapters(): Promise<void> {
    const adapters = this.list();
    await Promise.all(adapters.map(a => this.pollAdapter(a)));
  }

  private async pollAdapter(adapter: AdapterDescriptor): Promise<void> {
    const previous = this.lastHealth.get(adapter.name);
    let health: AdapterHealth;

    try {
      const client = new WatcherClient(adapter.socketPath);
      const result = await Promise.race([
        client.call_raw("health", {}),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("health poll timed out")), HEALTH_TIMEOUT_MS),
        ),
      ]);
      health = validateAdapterHealth(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      health = {
        status: "down",
        connectionStatus: "disconnected",
        stats: { messagesReceived: 0, messagesSent: 0, errors: 0 },
        lastMessageAgo: null,
        detail: msg,
      };
    }

    this.lastHealth.set(adapter.name, health);

    // Log on status change
    if (previous === undefined || previous.status !== health.status) {
      if (health.status === "ok") {
        log(`[hub] adapter ${adapter.name} health: ok`);
      } else {
        log(`[hub] WARNING: adapter ${adapter.name} health: ${health.status}${health.detail ? ` — ${health.detail}` : ""}`);
      }
    }
  }

  get(name: string): AdapterDescriptor | undefined {
    return this.adapters.get(name);
  }

  list(): AdapterDescriptor[] {
    return [...this.adapters.values()];
  }

  /**
   * Dispatch an incoming message from an adapter source through the
   * BrokerMessage routing pipeline.
   *
   * Phase 1 called commandHandler directly. Phase 3 creates a proper
   * BrokerMessage and routes it so PAILot messages flow through the
   * same adapter pipeline as everything else (PAILot -> hub -> Whazaa).
   *
   * Falls back to commandHandler if no adapters are registered (embedded-like).
   */
  dispatchIncoming(source: string, text: string, timestamp: number): void {
    log(`[hub] incoming from ${source}: ${text.slice(0, 80)}`);

    const type = text.trim().startsWith("/") ? "command" : "text";
    const message = createBrokerMessage(source, type, { text }, undefined);
    message.timestamp = timestamp;

    // Route through the standard pipeline
    void this.route(message).then((result) => {
      if (!result.ok) {
        // Fallback: if routing failed (e.g. no adapters registered),
        // try the local commandHandler for backward compatibility
        log(`[hub] route failed (${result.error}), falling back to commandHandler`);
        if (commandHandler) {
          void commandHandler(text, timestamp);
        } else {
          log(`[hub] no command handler and no adapters — message dropped`);
        }
      }
    });
  }

  // ── Phase 2: BrokerMessage Routing ──

  /**
   * Route a BrokerMessage to the appropriate adapter.
   *
   * Routing logic:
   * 1. If target is specified and adapter is registered -> deliver to that adapter
   * 2. If target is specified but not registered -> error
   * 3. If target is omitted and type is "command" -> run through commandHandler
   * 4. If target is omitted -> deliver to first registered messaging adapter
   * 5. If no adapters registered -> error
   */
  async route(message: BrokerMessage): Promise<RouteResult> {
    log(`[hub] route: ${message.type} from=${message.source} target=${message.target ?? "(default)"} text=${(message.payload.text ?? "").slice(0, 60)}`);

    // Explicit target
    if (message.target) {
      const adapter = this.adapters.get(message.target);
      if (!adapter) {
        return { ok: false, error: `Target adapter '${message.target}' is not registered` };
      }
      return this.deliverToAdapter(adapter, message);
    }

    // Commands and text messages with no explicit target -> hub command handler
    // Text messages from adapters are user input that needs to reach iTerm2/API sessions.
    if (message.type === "command" || message.type === "text") {
      const handler = this.hubCommandHandler;
      if (handler) {
        const sourceAdapter = this.adapters.get(message.source);
        const isPailot = message.source === "pailot";
        const ctx: CommandContext = {
          reply: async (text: string) => {
            if (isPailot) {
              broadcastText(text);
            } else if (sourceAdapter) {
              const replyMsg = createBrokerMessage("hub", "text", {
                text,
                recipient: message.payload.recipient,
              });
              await this.deliverToAdapter(sourceAdapter, replyMsg);
            } else {
              log(`[hub] no adapter for reply to ${message.source}`);
            }
          },
          replyImage: async (buffer: Buffer, caption: string) => {
            if (isPailot) {
              broadcastImage(buffer, caption);
            } else if (sourceAdapter) {
              const replyMsg = createBrokerMessage("hub", "image", {
                text: caption,
                buffer: buffer.toString("base64"),
                recipient: message.payload.recipient,
              });
              await this.deliverToAdapter(sourceAdapter, replyMsg);
            }
          },
          replyVoice: async (audioBuffer: Buffer, caption: string) => {
            if (isPailot) {
              broadcastVoice(audioBuffer, caption);
            } else if (sourceAdapter) {
              const replyMsg = createBrokerMessage("hub", "voice", {
                buffer: audioBuffer.toString("base64"),
                text: caption,
                recipient: message.payload.recipient,
              });
              await this.deliverToAdapter(sourceAdapter, replyMsg);
            }
          },
          source: message.source,
          recipient: message.payload.recipient,
        };
        await handler(message.payload.text ?? "", message.timestamp, ctx);
        return { ok: true, deliveredTo: "hub" };
      }
      // Fallback to old-style commandHandler
      if (commandHandler) {
        await commandHandler(message.payload.text ?? "", message.timestamp);
        return { ok: true, deliveredTo: "hub" };
      }
      return { ok: false, error: "No command handler registered on the hub" };
    }

    // Default routing: first registered adapter that is NOT the source
    const candidates = this.list().filter(a => a.name !== message.source);
    if (candidates.length === 0) {
      // Fall back to any adapter (including source, for self-chat scenarios)
      const any = this.list();
      if (any.length === 0) {
        return { ok: false, error: "No adapters registered — cannot route message" };
      }
      return this.deliverToAdapter(any[0], message);
    }

    return this.deliverToAdapter(candidates[0], message);
  }

  /**
   * Deliver a BrokerMessage to an adapter via its IPC socket.
   *
   * The hub acts as an IPC client, connecting to the adapter's socket
   * and calling the "deliver" method with the message as payload.
   */
  async deliverToAdapter(
    adapter: AdapterDescriptor,
    message: BrokerMessage,
  ): Promise<RouteResult> {
    log(`[hub] delivering to ${adapter.name} via ${adapter.socketPath}`);

    const client = new WatcherClient(adapter.socketPath);
    try {
      const result = await client.call_raw("deliver", {
        message: message as unknown as Record<string, unknown>,
      });
      return { ok: true, deliveredTo: adapter.name, adapterResult: result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[hub] delivery to ${adapter.name} failed: ${msg}`);
      return { ok: false, error: `Delivery to ${adapter.name} failed: ${msg}` };
    }
  }
}
