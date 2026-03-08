/**
 * AIBP — AIBroker Interchange Protocol
 *
 * Public API for the protocol layer.
 */

export * from "./types.js";
export * as msg from "./envelope.js";
export { PluginRegistry } from "./registry.js";
export type { SendFn } from "./registry.js";
export { AibpBridge } from "./bridge.js";
