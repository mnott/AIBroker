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

export interface AdapterDescriptor {
  name: string;       // "whazaa", "telex", "pailot"
  socketPath: string; // adapter's own IPC socket (for reverse calls)
  registeredAt: number;
}

export class AdapterRegistry {
  private readonly adapters = new Map<string, AdapterDescriptor>();

  register(descriptor: AdapterDescriptor): void {
    this.adapters.set(descriptor.name, descriptor);
    log(`Adapter registered: ${descriptor.name} (socket: ${descriptor.socketPath})`);
  }

  unregister(name: string): void {
    this.adapters.delete(name);
    log(`Adapter unregistered: ${name}`);
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

    const message = createBrokerMessage(source, "command", { text }, undefined);
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

    // Commands with no explicit target -> hub commandHandler
    if (message.type === "command") {
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
