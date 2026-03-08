/**
 * AIBP Plugin Registry — manages plugin connections, channels, and routing.
 *
 * This is the hub's brain. It knows:
 * - Which plugins are registered and their capabilities
 * - Which channels exist and who has joined them
 * - Where to route each message based on dst address
 * - What to buffer when a recipient is offline
 */

import { log } from "../core/log.js";
import * as envelope from "./envelope.js";
import type {
  AibpMessage,
  ChannelMembership,
  CommandSpec,
  PluginSpec,
  RegisteredPlugin,
} from "./types.js";

const MAX_OUTBOX = 50;
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_MISS_DEGRADED = 3;
const HEARTBEAT_MISS_DEAD = 5;

export type SendFn = (msg: AibpMessage) => void;

interface PluginConnection {
  plugin: RegisteredPlugin;
  send: SendFn;
}

export class PluginRegistry {
  /** address → connection */
  private plugins = new Map<string, PluginConnection>();
  /** channel name → membership */
  private channels = new Map<string, ChannelMembership>();
  /** command name → plugin address */
  private commands = new Map<string, string>();

  // -------------------------------------------------------------------------
  // Plugin lifecycle
  // -------------------------------------------------------------------------

  /**
   * Register a plugin. Returns the REGISTER_ACK message to send back,
   * or an ERROR message if registration fails.
   */
  register(spec: PluginSpec, send: SendFn): AibpMessage {
    const address = this.resolveAddress(spec);

    // Reject duplicate
    if (this.plugins.has(address)) {
      log(`[AIBP] REGISTER rejected: ${address} already registered`);
      return envelope.system("hub:local", address, "ERROR", {
        code: "REGISTER_REJECTED",
        reason: `Plugin address ${address} already registered`,
      });
    }

    const plugin: RegisteredPlugin = {
      spec,
      address,
      connectedAt: Date.now(),
      missedPings: 0,
      status: "active",
      joinedChannels: new Set(),
    };

    this.plugins.set(address, { plugin, send });

    // Register commands
    if (spec.commands) {
      for (const cmd of spec.commands) {
        this.commands.set(cmd.name, address);
      }
    }

    // Auto-join declared channels
    for (const ch of spec.channels) {
      this.join(address, ch);
    }

    log(`[AIBP] REGISTER ${spec.type}:${spec.id} → ${address}`);

    const peers = Array.from(this.plugins.keys()).filter((a) => a !== address);
    return envelope.system("hub:local", address, "REGISTER_ACK", {
      assignedAddress: address,
      hubVersion: "0.1",
      peers,
    });
  }

  /**
   * Unregister a plugin (graceful disconnect or crash cleanup).
   */
  unregister(address: string, reason = "disconnected"): void {
    const conn = this.plugins.get(address);
    if (!conn) return;

    // Part all joined channels
    for (const ch of conn.plugin.joinedChannels) {
      this.part(address, ch, reason);
    }

    // Remove commands
    if (conn.plugin.spec.commands) {
      for (const cmd of conn.plugin.spec.commands) {
        if (this.commands.get(cmd.name) === address) {
          this.commands.delete(cmd.name);
        }
      }
    }

    this.plugins.delete(address);
    log(`[AIBP] UNREGISTER ${address} (${reason})`);

    // Notify all remaining plugins
    for (const [, other] of this.plugins) {
      other.send(
        envelope.system("hub:local", other.plugin.address, "PLUGIN_OFFLINE", {
          plugin: address,
          reason,
        }),
      );
    }
  }

  // -------------------------------------------------------------------------
  // Channel management
  // -------------------------------------------------------------------------

  /**
   * Join a channel. Creates the channel if it doesn't exist.
   */
  join(address: string, channel: string): AibpMessage {
    let membership = this.channels.get(channel);
    if (!membership) {
      membership = { channel, members: new Set(), outbox: [] };
      this.channels.set(channel, membership);
    }

    membership.members.add(address);

    const conn = this.plugins.get(address);
    if (conn) {
      conn.plugin.joinedChannels.add(channel);
    }

    log(`[AIBP] JOIN ${address} → ${channel} (${membership.members.size} members)`);

    // Drain outbox for this member
    const buffered = membership.outbox.length;
    if (buffered > 0) {
      this.drainOutbox(address, channel);
    }

    return envelope.system("hub:local", address, "JOIN_ACK", {
      channel,
      members: Array.from(membership.members),
      unreadCount: buffered,
    });
  }

  /**
   * Part a channel.
   */
  part(address: string, channel: string, reason = "left"): AibpMessage {
    const membership = this.channels.get(channel);
    if (membership) {
      membership.members.delete(address);
      // Clean up empty channels (except persistent session channels)
      if (membership.members.size === 0 && !channel.startsWith("session:")) {
        this.channels.delete(channel);
      }
    }

    const conn = this.plugins.get(address);
    if (conn) {
      conn.plugin.joinedChannels.delete(channel);
    }

    log(`[AIBP] PART ${address} ← ${channel} (${reason})`);

    return envelope.system("hub:local", address, "PART_ACK", {
      channel,
      reason,
    });
  }

  // -------------------------------------------------------------------------
  // Message routing — the core of AIBP
  // -------------------------------------------------------------------------

  /**
   * Route a message to its destination.
   *
   * Routing rules:
   * 1. If dst is a direct address (plugin/session/mobile), deliver to that plugin
   * 2. If dst is a channel, fan out to all members
   * 3. If dst is "hub:local", handle as a hub command
   * 4. If dst contains "/" (mesh), forward to bridge plugin
   * 5. If recipient is offline, buffer in outbox
   */
  route(msg: AibpMessage): void {
    const { dst } = msg;

    // Mesh routing — forward to the appropriate bridge
    const mesh = envelope.parseMeshAddress(dst);
    if (mesh) {
      this.routeToMesh(msg, mesh.hub, mesh.local);
      return;
    }

    // Hub command
    if (dst === "hub:local") {
      this.handleHubMessage(msg);
      return;
    }

    // Direct plugin address
    const directConn = this.plugins.get(dst);
    if (directConn) {
      directConn.send(msg);
      return;
    }

    // Channel fan-out
    const membership = this.channels.get(dst);
    if (membership) {
      this.fanOut(msg, membership);
      return;
    }

    // Try to match as a session channel
    if (dst.startsWith("session:")) {
      // Auto-create the channel and buffer
      const newMembership: ChannelMembership = {
        channel: dst,
        members: new Set(),
        outbox: [],
      };
      this.channels.set(dst, newMembership);
      this.bufferMessage(newMembership, msg);
      return;
    }

    log(`[AIBP] ROUTE FAIL: no destination for ${dst} (from ${msg.src})`);
  }

  private fanOut(msg: AibpMessage, membership: ChannelMembership): void {
    membership.lastMessageId = msg.id;
    membership.lastMessageTs = msg.ts;

    let delivered = 0;
    for (const member of membership.members) {
      // Don't echo back to sender
      if (member === msg.src) continue;

      const conn = this.plugins.get(member);
      if (conn) {
        conn.send(msg);
        delivered++;
      }
    }

    // Buffer for offline members who have joined this channel before
    if (delivered === 0 && membership.members.size === 0) {
      this.bufferMessage(membership, msg);
    }
  }

  private routeToMesh(msg: AibpMessage, hubAddress: string, localDst: string): void {
    // Extract the hub ID from hub address (e.g., "hub:mac-mini" → "mac-mini")
    const hubId = hubAddress.startsWith("hub:") ? hubAddress.slice(4) : hubAddress;

    // Try to find the specific bridge for this hub first
    const specificBridge = this.plugins.get(`bridge:${hubId}`);
    if (specificBridge) {
      specificBridge.send(msg);
      return;
    }

    // Fallback: find any bridge plugin
    for (const [, conn] of this.plugins) {
      if (conn.plugin.spec.type === "bridge") {
        conn.send(msg);
        return;
      }
    }
    log(`[AIBP] MESH FAIL: no bridge plugin for ${hubAddress}`);
  }

  private handleHubMessage(msg: AibpMessage): void {
    if (msg.type === "COMMAND") {
      const payload = msg.payload as { command: string; args: Record<string, unknown> };
      const cmdOwner = this.commands.get(payload.command);
      if (cmdOwner) {
        const conn = this.plugins.get(cmdOwner);
        if (conn) {
          conn.send(msg);
          return;
        }
      }
      // Built-in hub commands
      this.handleBuiltinCommand(msg, payload.command, payload.args);
      return;
    }

    if (msg.type === "SYSTEM") {
      const payload = msg.payload as { event: string };
      if (payload.event === "PING") {
        const conn = this.plugins.get(msg.src);
        if (conn) {
          conn.plugin.lastPing = Date.now();
          conn.plugin.missedPings = 0;
          conn.plugin.status = "active";
          conn.send(envelope.system("hub:local", msg.src, "PONG"));
        }
      }
    }
  }

  private handleBuiltinCommand(
    msg: AibpMessage,
    cmd: string,
    args: Record<string, unknown>,
  ): void {
    const src = msg.src;

    switch (cmd) {
      case "list_channels": {
        const channels = Array.from(this.channels.entries()).map(([name, m]) => ({
          name,
          members: m.members.size,
          lastActivity: m.lastMessageTs,
          outboxSize: m.outbox.length,
        }));
        const reply = envelope.system("hub:local", src, "REGISTER_ACK", { channels });
        this.sendTo(src, reply);
        break;
      }

      case "list_plugins": {
        const plugins = Array.from(this.plugins.entries()).map(([addr, c]) => ({
          address: addr,
          type: c.plugin.spec.type,
          name: c.plugin.spec.name,
          status: c.plugin.status,
          channels: Array.from(c.plugin.joinedChannels),
        }));
        const reply = envelope.system("hub:local", src, "REGISTER_ACK", { plugins });
        this.sendTo(src, reply);
        break;
      }

      default:
        log(`[AIBP] Unknown hub command: ${cmd}`);
        this.sendTo(
          src,
          envelope.system("hub:local", src, "ERROR", {
            code: "UNKNOWN_COMMAND",
            command: cmd,
          }),
        );
    }
  }

  // -------------------------------------------------------------------------
  // Outbox
  // -------------------------------------------------------------------------

  private bufferMessage(membership: ChannelMembership, msg: AibpMessage): void {
    // Don't buffer typing indicators or pings
    if (msg.type === "TYPING" || msg.type === "SYSTEM") return;

    if (membership.outbox.length >= MAX_OUTBOX) {
      membership.outbox.shift(); // Drop oldest
    }
    membership.outbox.push(msg);
    log(`[AIBP] OUTBOX ${msg.dst}: ${membership.outbox.length} buffered`);
  }

  private drainOutbox(address: string, channel: string): void {
    const membership = this.channels.get(channel);
    if (!membership || membership.outbox.length === 0) return;

    const conn = this.plugins.get(address);
    if (!conn) return;

    const count = membership.outbox.length;

    // Send drain header
    conn.send(
      envelope.system("hub:local", address, "OUTBOX_DRAIN", {
        channel,
        count,
        summary: `${count} message${count > 1 ? "s" : ""} while offline`,
      }),
    );

    // Deliver buffered messages
    for (const msg of membership.outbox) {
      conn.send(msg);
    }

    membership.outbox = [];
    log(`[AIBP] OUTBOX DRAIN ${channel} → ${address}: ${count} messages`);
  }

  // -------------------------------------------------------------------------
  // Heartbeat monitoring
  // -------------------------------------------------------------------------

  /**
   * Call periodically (e.g., every 30s) to check plugin health.
   */
  heartbeatCheck(): void {
    for (const [address, conn] of this.plugins) {
      conn.plugin.missedPings++;

      if (conn.plugin.missedPings >= HEARTBEAT_MISS_DEAD) {
        log(`[AIBP] Plugin dead: ${address} (${conn.plugin.missedPings} missed pings)`);
        this.unregister(address, "heartbeat timeout");
      } else if (conn.plugin.missedPings >= HEARTBEAT_MISS_DEGRADED) {
        conn.plugin.status = "degraded";
        log(`[AIBP] Plugin degraded: ${address}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  getPlugin(address: string): RegisteredPlugin | undefined {
    return this.plugins.get(address)?.plugin;
  }

  getChannel(channel: string): ChannelMembership | undefined {
    return this.channels.get(channel);
  }

  getPluginByType(type: string): RegisteredPlugin[] {
    return Array.from(this.plugins.values())
      .filter((c) => c.plugin.spec.type === type)
      .map((c) => c.plugin);
  }

  getCommandOwner(command: string): string | undefined {
    return this.commands.get(command);
  }

  listPlugins(): RegisteredPlugin[] {
    return Array.from(this.plugins.values()).map((c) => c.plugin);
  }

  listChannels(): ChannelMembership[] {
    return Array.from(this.channels.values());
  }

  listCommands(): Array<{ name: string; owner: string; spec?: CommandSpec }> {
    return Array.from(this.commands.entries()).map(([name, owner]) => {
      const conn = this.plugins.get(owner);
      const spec = conn?.plugin.spec.commands?.find((c) => c.name === name);
      return { name, owner, spec };
    });
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private sendTo(address: string, msg: AibpMessage): void {
    const conn = this.plugins.get(address);
    if (conn) conn.send(msg);
  }

  private resolveAddress(spec: PluginSpec): string {
    switch (spec.type) {
      case "transport":
        return `transport:${spec.id}`;
      case "terminal":
        return `terminal:${spec.id}`;
      case "mobile":
        return `mobile:${spec.id}`;
      case "bridge":
        return `bridge:${spec.id}`;
      case "mcp":
        return `mcp:${spec.id}`;
      case "hub":
        return `hub:${spec.id}`;
      default:
        return `plugin:${spec.id}`;
    }
  }
}
