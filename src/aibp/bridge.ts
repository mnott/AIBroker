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
  private sessionHandlerAddress: string | null = null;

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
   * Terminal-specific commands (keyboard control) are registered here.
   */
  registerTerminal(
    id: string,
    sendFn: SendFn,
    commands?: PluginSpec["commands"],
  ): void {
    const spec: PluginSpec = {
      id,
      type: "terminal",
      name: `Terminal (${id})`,
      capabilities: ["TEXT", "COMMAND"],
      channels: [],
      commands,
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

  /**
   * Route a message from the hub to a terminal plugin (iTerm2).
   * Used by the command handler to deliver text to terminal sessions.
   */
  routeToTerminal(
    sessionId: string,
    content: string,
    type: "TEXT" | "COMMAND" = "TEXT",
  ): boolean {
    const terminalPlugins = this.registry.getPluginByType("terminal");
    if (terminalPlugins.length === 0) return false;

    const src = sessionId ? `session:${sessionId}` : "hub:local";
    const dst = terminalPlugins[0].address;

    let message: AibpMessage;
    if (type === "COMMAND") {
      message = msg.command(src, dst, "type", { text: content, sessionId });
    } else {
      message = msg.text(src, dst, content);
    }

    this.registry.route(message);
    return true;
  }

  /**
   * Register the hub's session handler as a plugin.
   * This plugin joins session channels and receives inbound messages
   * destined for sessions (e.g., from PAILot). The sendFn callback
   * should dispatch to the hub command handler.
   *
   * Hub-owned slash commands are registered here so they're discoverable
   * through the AIBP command registry.
   */
  registerSessionHandler(sendFn: SendFn): void {
    const spec: PluginSpec = {
      id: "session-handler",
      type: "hub",
      name: "Session Handler",
      capabilities: ["TEXT", "VOICE", "IMAGE", "COMMAND"],
      channels: [],
      commands: [
        { name: "h", description: "Show available commands", args: "" },
        { name: "help", description: "Show available commands", args: "" },
        { name: "s", description: "List sessions", args: "" },
        { name: "sessions", description: "List sessions", args: "" },
        { name: "n", description: "New visual session", args: "<path>" },
        { name: "nv", description: "New visual session (alias)", args: "<path>" },
        { name: "new", description: "New visual session (alias)", args: "<path>" },
        { name: "nh", description: "New headless (API) session", args: "<path>" },
        { name: "ss", description: "Screenshot active session", args: "" },
        { name: "screenshot", description: "Screenshot active session", args: "" },
        { name: "c", description: "Clear and restart active session", args: "" },
        { name: "p", description: "Pause active session", args: "" },
        { name: "r", description: "Restart Claude in session N", args: "<N>" },
        { name: "e", description: "End session N", args: "<N>" },
        { name: "end", description: "End session N (alias)", args: "<N>" },
        { name: "t", description: "Open terminal tab", args: "[command]" },
        { name: "terminal", description: "Open terminal tab (alias)", args: "[command]" },
        { name: "image", description: "Generate an image", args: "<prompt>" },
        { name: "img", description: "Generate an image (alias)", args: "<prompt>" },
        { name: "restart", description: "Restart the adapter", args: "" },
        { name: "status", description: "Show status of all Claude sessions", args: "" },
        { name: "st", description: "Show status of all Claude sessions (alias)", args: "" },
      ],
    };
    this.registry.register(spec, sendFn);
    this.sessionHandlerAddress = "hub:session-handler";
    log("[AIBP Bridge] Session handler registered");
  }

  /**
   * Ensure the session handler is joined to a session channel.
   * Called automatically before routing inbound messages.
   */
  private ensureSessionJoin(sessionId: string): void {
    if (!this.sessionHandlerAddress || !sessionId) return;
    const channel = `session:${sessionId}`;
    const ch = this.registry.getChannel(channel);
    if (!ch || !ch.members.has(this.sessionHandlerAddress)) {
      this.registry.join(this.sessionHandlerAddress, channel);
    }
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
    // Ensure the hub session handler is joined to this session channel
    // so it can receive the message when the registry fans it out.
    this.ensureSessionJoin(sessionId);

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
      case "VOICE": {
        const chunkMeta = extra?.groupId
          ? { groupId: extra.groupId as string, chunkIndex: extra.chunkIndex as number, totalChunks: extra.totalChunks as number }
          : undefined;
        message = msg.voice(
          src,
          dst,
          (extra?.audioBase64 as string) ?? "",
          content,
          extra?.durationMs as number | undefined,
          chunkMeta,
        );
        break;
      }
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
   * Route a message from one session to another.
   * Used for cross-session messaging (session A → session B).
   */
  routeBetweenSessions(
    fromSessionId: string,
    toSessionId: string,
    content: string,
    type: "TEXT" | "COMMAND" = "TEXT",
  ): void {
    const src = `session:${fromSessionId}`;
    const dst = `session:${toSessionId}`;

    // Ensure the hub is joined to the target session so it can deliver
    this.ensureSessionJoin(toSessionId);

    let message: AibpMessage;
    if (type === "COMMAND") {
      message = msg.command(src, dst, "cross-session", { text: content, fromSession: fromSessionId });
    } else {
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
  // Mesh networking — bridge-to-bridge (Step 5)
  // -------------------------------------------------------------------------

  /**
   * Register a remote hub as a bridge plugin.
   * Messages addressed to hub:<hubId>/... are forwarded to this plugin's sendFn,
   * which should deliver them over the network to the remote hub.
   */
  registerBridge(
    hubId: string,
    sendFn: SendFn,
  ): void {
    const spec: PluginSpec = {
      id: hubId,
      type: "bridge",
      name: `Bridge (${hubId})`,
      capabilities: ["TEXT", "VOICE", "IMAGE", "COMMAND", "FILE"],
      channels: [],
    };
    this.registry.register(spec, sendFn);
    log(`[AIBP Bridge] Bridge plugin registered: ${hubId}`);
  }

  /**
   * Send a message to a remote hub via mesh addressing.
   * The message dst is set to hub:<hubId>/<remoteDst>.
   * Returns false if no bridge is registered for that hub.
   */
  routeToRemote(
    hubId: string,
    remoteDst: string,
    content: string,
    localSessionId?: string,
    type: "TEXT" | "VOICE" | "COMMAND" = "TEXT",
    extra?: Record<string, unknown>,
  ): boolean {
    const bridgePlugin = this.registry.getPlugin(`bridge:${hubId}`);
    if (!bridgePlugin) return false;

    const src = localSessionId ? `session:${localSessionId}` : "hub:local";
    const dst = `hub:${hubId}/${remoteDst}`;

    let message: AibpMessage;
    switch (type) {
      case "VOICE":
        message = msg.voice(
          src, dst,
          (extra?.audioBase64 as string) ?? "",
          content,
          extra?.durationMs as number | undefined,
        );
        break;
      case "COMMAND":
        message = msg.command(src, dst, "remote", { text: content });
        break;
      default:
        message = msg.text(src, dst, content);
    }

    this.registry.route(message);
    return true;
  }

  /**
   * Handle a message arriving from a remote hub.
   * The bridge network layer calls this when it receives an AIBP message
   * from another hub destined for a local session.
   */
  routeFromRemote(
    fromHubId: string,
    localDst: string,
    content: string,
    remoteSrc: string,
    type: "TEXT" | "VOICE" | "IMAGE" = "TEXT",
    extra?: Record<string, unknown>,
  ): void {
    // Prefix the source with the remote hub so local plugins know the origin
    const src = `hub:${fromHubId}/${remoteSrc}`;

    // Ensure the session handler is joined to the target session
    if (localDst.startsWith("session:")) {
      this.ensureSessionJoin(localDst.slice(8));
    }

    let message: AibpMessage;
    switch (type) {
      case "VOICE":
        message = msg.voice(
          src, localDst,
          (extra?.audioBase64 as string) ?? "",
          content,
          extra?.durationMs as number | undefined,
        );
        break;
      case "IMAGE":
        message = msg.image(
          src, localDst,
          (extra?.imageBase64 as string) ?? "",
          (extra?.mimeType as string) ?? "image/jpeg",
          content,
        );
        break;
      default:
        message = msg.text(src, localDst, content);
    }

    this.registry.route(message);
  }

  /**
   * List all registered peer hub IDs (bridge plugins).
   */
  listPeers(): string[] {
    return this.registry.getPluginByType("bridge").map(p => p.spec.id);
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

  /** List all registered commands with their owning plugins */
  listCommands() {
    return this.registry.listCommands();
  }

  /** Resolve which plugin owns a command */
  getCommandOwner(command: string): string | undefined {
    return this.registry.getCommandOwner(command);
  }
}
