/**
 * AIBP IPC Bridge — translates legacy IPC requests into AIBP messages
 * and routes them through the PluginRegistry.
 *
 * This is the Phase 2 integration layer. Existing adapters (Whazaa, Telex)
 * continue using the old IPC protocol. The bridge translates their calls
 * to AIBP messages so the PluginRegistry handles routing.
 *
 * New plugins (PAILot, MCP) register directly via AIBP handshake.
 */

import { log } from "../core/log.js";
import * as msg from "./envelope.js";
import { PluginRegistry, type SendFn } from "./registry.js";
import type { AibpMessage, PluginSpec } from "./types.js";

export class AibpBridge {
  readonly registry: PluginRegistry;
  private mobileCallbacks = new Map<string, (msg: AibpMessage) => void>();

  constructor() {
    this.registry = new PluginRegistry();
  }

  // -------------------------------------------------------------------------
  // Plugin registration shortcuts
  // -------------------------------------------------------------------------

  /**
   * Register the PAILot mobile gateway as a plugin.
   * The callback receives AIBP messages to deliver to connected WebSocket clients.
   */
  registerMobile(
    id: string,
    callback: (msg: AibpMessage) => void,
  ): void {
    const spec: PluginSpec = {
      id,
      type: "mobile",
      name: `PAILot (${id})`,
      capabilities: ["TEXT", "VOICE", "IMAGE", "TYPING", "STATUS"],
      channels: [],
    };
    const ack = this.registry.register(spec, callback);
    this.mobileCallbacks.set(`mobile:${id}`, callback);
    log(`[AIBP Bridge] Mobile plugin registered: ${id}`);
  }

  /**
   * Register a transport adapter (Whazaa, Telex) as a plugin.
   * These use legacy IPC — the sendFn wraps an IPC call back to the adapter.
   */
  registerTransport(
    id: string,
    sendFn: SendFn,
    commands?: PluginSpec["commands"],
  ): void {
    const spec: PluginSpec = {
      id,
      type: "transport",
      name: id.charAt(0).toUpperCase() + id.slice(1),
      capabilities: ["TEXT", "VOICE", "IMAGE", "FILE"],
      channels: [`transport:${id}`],
      commands,
    };
    this.registry.register(spec, sendFn);
    log(`[AIBP Bridge] Transport plugin registered: ${id}`);
  }

  /**
   * Register a terminal plugin (iTerm2).
   */
  registerTerminal(
    id: string,
    sendFn: SendFn,
  ): void {
    const spec: PluginSpec = {
      id,
      type: "terminal",
      name: `Terminal (${id})`,
      capabilities: ["TEXT", "COMMAND"],
      channels: [],
    };
    this.registry.register(spec, sendFn);
    log(`[AIBP Bridge] Terminal plugin registered: ${id}`);
  }

  /**
   * Register an MCP process as a plugin.
   * Returns the resolved session address for the MCP to use.
   */
  registerMcp(
    mcpId: string,
    sessionEnvId?: string,
    sendFn?: SendFn,
  ): { address: string; resolvedSession?: string } {
    const spec: PluginSpec = {
      id: mcpId,
      type: "mcp",
      name: `MCP (${mcpId})`,
      capabilities: ["TEXT", "VOICE", "IMAGE", "COMMAND"],
      channels: [],
    };
    const ack = this.registry.register(spec, sendFn ?? (() => {}));
    const address = `mcp:${mcpId}`;

    // If we have a session env ID, try to resolve which session this MCP belongs to
    let resolvedSession: string | undefined;
    if (sessionEnvId) {
      // Try to find a matching session channel
      for (const ch of this.registry.listChannels()) {
        if (ch.channel.startsWith("session:") && ch.channel.includes(sessionEnvId)) {
          resolvedSession = ch.channel;
          break;
        }
      }
      // If no exact match, create one
      if (!resolvedSession) {
        resolvedSession = `session:${sessionEnvId}`;
      }
      this.registry.join(address, resolvedSession);
    }

    log(`[AIBP Bridge] MCP plugin registered: ${mcpId} → session: ${resolvedSession ?? "unresolved"}`);
    return { address, resolvedSession };
  }

  // -------------------------------------------------------------------------
  // Message routing
  // -------------------------------------------------------------------------

  /**
   * Route a message from PAILot to a session.
   */
  routeFromMobile(
    sessionId: string,
    content: string,
    type: "TEXT" | "VOICE" | "IMAGE" = "TEXT",
    extra?: Record<string, unknown>,
  ): void {
    let message: AibpMessage;
    const dst = `session:${sessionId}`;

    switch (type) {
      case "VOICE":
        message = msg.voice(
          "mobile:pailot",
          dst,
          (extra?.audioBase64 as string) ?? "",
          content,
          extra?.durationMs as number | undefined,
        );
        break;
      case "IMAGE":
        message = msg.image(
          "mobile:pailot",
          dst,
          (extra?.imageBase64 as string) ?? "",
          (extra?.mimeType as string) ?? "image/jpeg",
          content,
        );
        break;
      default:
        message = msg.text("mobile:pailot", dst, content);
    }

    this.registry.route(message);
  }

  /**
   * Route a response from a session back to PAILot.
   * This is called when Claude sends via pailot_send.
   */
  routeToMobile(
    sessionId: string,
    content: string,
    type: "TEXT" | "VOICE" | "IMAGE" | "TYPING" = "TEXT",
    extra?: Record<string, unknown>,
  ): void {
    const src = sessionId ? `session:${sessionId}` : "hub:local";
    const dst = "mobile:pailot";

    let message: AibpMessage;
    switch (type) {
      case "VOICE":
        message = msg.voice(
          src,
          dst,
          (extra?.audioBase64 as string) ?? "",
          content,
          extra?.durationMs as number | undefined,
        );
        break;
      case "IMAGE":
        message = msg.image(
          src,
          dst,
          (extra?.imageBase64 as string) ?? "",
          (extra?.mimeType as string) ?? "image/jpeg",
          content,
        );
        break;
      case "TYPING":
        message = msg.typing(src, dst, (extra?.active as boolean) ?? false);
        break;
      default:
        message = msg.text(src, dst, content);
    }

    this.registry.route(message);
  }

  /**
   * Send a typing indicator.
   */
  sendTyping(sessionId: string, active: boolean): void {
    const src = sessionId ? `session:${sessionId}` : "hub:local";
    this.registry.route(msg.typing(src, "mobile:pailot", active));
  }

  /**
   * Join the PAILot mobile plugin to a session channel.
   * This is called when the user switches sessions on PAILot.
   */
  joinSession(sessionId: string): void {
    this.registry.join("mobile:pailot", `session:${sessionId}`);
  }

  /**
   * Part the PAILot mobile plugin from a session channel.
   */
  partSession(sessionId: string): void {
    this.registry.part("mobile:pailot", `session:${sessionId}`);
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /** Get all registered plugin addresses */
  listPlugins(): string[] {
    return this.registry.listPlugins().map((p) => p.address);
  }

  /** Get channel membership info */
  getChannelInfo(channel: string) {
    return this.registry.getChannel(channel);
  }
}
