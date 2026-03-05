/**
 * daemon/adapter-registry.ts — Registry of connected adapters.
 *
 * In Phase 1 this is minimal: just tracks which adapters are registered
 * and provides a dispatch path for incoming messages from any source.
 *
 * Phase 2 will expand this into the full BrokerMessage routing system.
 */

import { commandHandler } from "../core/state.js";
import { log } from "../core/log.js";

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

  list(): AdapterDescriptor[] {
    return [...this.adapters.values()];
  }

  /**
   * Dispatch an incoming message from an adapter source into the hub's
   * command handler. In Phase 1 this routes to the shared commandHandler
   * (same as the watcher's handleMessage). In Phase 2 this becomes the
   * full BrokerMessage routing engine.
   */
  dispatchIncoming(source: string, text: string, timestamp: number): void {
    log(`[hub] incoming from ${source}: ${text.slice(0, 80)}`);
    if (commandHandler) {
      void commandHandler(text, timestamp);
    } else {
      log(`[hub] no command handler registered — message dropped`);
    }
  }
}
