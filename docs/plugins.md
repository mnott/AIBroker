# Plugin System

Plugins are the participants in the AIBP routing fabric. Every entity that sends or receives messages through AIBroker is a plugin: transport adapters, the PAILot mobile gateway, the iTerm2 terminal, MCP server processes, and the hub itself.

## Plugin Types

Six plugin types are defined in `src/aibp/types.ts`:

```typescript
type PluginType = "transport" | "terminal" | "mobile" | "bridge" | "mcp" | "hub";
```

| Type | Address format | Purpose | Example |
|------|----------------|---------|---------|
| `transport` | `transport:id` | Messaging platform adapter | Whazaa (WhatsApp), Telex (Telegram) |
| `terminal` | `terminal:id` | Terminal session manager | iTerm2 |
| `mobile` | `mobile:id` | Mobile app gateway | PAILot iOS |
| `bridge` | `bridge:id` | Remote hub link | mesh networking |
| `mcp` | `mcp:id` | MCP server process | Claude Code's MCP client |
| `hub` | `hub:id` | Hub-internal plugin | session-handler |

## PluginSpec Schema

Every plugin declares itself with a `PluginSpec`:

```typescript
interface PluginSpec {
  id: string;                    // Unique identifier (no spaces)
  type: PluginType;              // Determines address prefix
  name: string;                  // Human-readable display name
  version?: string;              // Optional semantic version
  capabilities: MessageType[];   // Message types this plugin can handle
  channels: string[];            // Channels to auto-join on registration
  commands?: CommandSpec[];      // Slash commands this plugin owns
}
```

### CommandSpec

```typescript
interface CommandSpec {
  name: string;        // Command name without slash (e.g., "ss", "s")
  description: string; // Human-readable description
  args: string;        // Args format string (e.g., "<N>", "[path]")
  subcommands?: CommandSpec[]; // Nested subcommands
}
```

## Registration Flow

Registration happens when a plugin's `sendFn` is provided to `registry.register(spec, sendFn)`. The registry:

1. Resolves the plugin's canonical address from `spec.type` and `spec.id`
2. Rejects with `ERROR/REGISTER_REJECTED` if the address is already taken
3. Creates a `RegisteredPlugin` entry with `status: "active"`, `missedPings: 0`
4. Registers all declared commands in the command map
5. Auto-joins all declared channels (calls `registry.join()` for each)
6. Drains any pending outbox messages for the declared channels
7. Returns a `REGISTER_ACK` with the assigned address, hub version, and current peer list

```typescript
// Example: registering a transport adapter
const spec: PluginSpec = {
  id: "whazaa",
  type: "transport",
  name: "Whazaa",
  capabilities: ["TEXT", "VOICE", "IMAGE", "FILE"],
  channels: ["transport:whazaa"],
};
const ack = registry.register(spec, sendFn);
// ack.payload.assignedAddress === "transport:whazaa"
```

The convenience methods on `AibpBridge` handle spec assembly:

```typescript
// Transport adapter
aibpBridge.registerTransport("whazaa", sendFn, commands?);

// Mobile gateway
aibpBridge.registerMobile("pailot", callback);

// Terminal plugin
aibpBridge.registerTerminal("iterm", sendFn, terminalCommands);

// MCP process
const { address, resolvedSession } = aibpBridge.registerMcp(pluginId, sessionEnvId, sendFn?);

// Hub-internal plugin
aibpBridge.registerSessionHandler(sendFn);

// Mesh bridge
aibpBridge.registerBridge(hubId, sendFn);
```

## Capabilities

The `capabilities` field declares which message types a plugin can handle. This is informational metadata — the registry does not filter deliveries based on capabilities. However, it is used when building the AIBP status response (`aibroker_aibp_status`) so operators can see what each plugin supports.

Declared capabilities for the built-in plugins:

| Plugin | Capabilities |
|--------|-------------|
| transport (Whazaa/Telex) | TEXT, VOICE, IMAGE, FILE |
| mobile (PAILot) | TEXT, VOICE, IMAGE, TYPING, STATUS |
| terminal (iTerm2) | TEXT, COMMAND |
| hub (session-handler) | TEXT, VOICE, IMAGE, COMMAND |
| mcp | TEXT, VOICE, IMAGE, COMMAND |
| bridge | TEXT, VOICE, IMAGE, COMMAND, FILE |

## Channel Management

### Declaring Channels at Registration

Channels listed in `spec.channels` are joined automatically during `register()`. The plugin receives JOIN_ACK for each channel, and any outbox messages are drained immediately.

Transport adapters auto-join their own transport channel:

```typescript
channels: ["transport:whazaa"]
```

Session-based plugins (hub session handler, PAILot) join session channels dynamically when sessions are created or switched.

### Dynamic Channel Join/Part

```typescript
// Join a session channel (called when a session is created or PAILot switches sessions)
registry.join("mobile:pailot", "session:ABC123");
// → Returns JOIN_ACK
// → Drains outbox for mobile:pailot on that channel

// Part a channel
registry.part("mobile:pailot", "session:ABC123", "user switched");
// → Returns PART_ACK
// → Channel is deleted if empty and not a persistent session channel
```

Persistent session channels (starting with `session:`) are not deleted when their last member leaves. This allows messages to be buffered even before any plugin joins.

## Command Registration

When a plugin registers commands in `spec.commands`, each command name is mapped to the plugin's address in the registry's command table. When a `COMMAND` message arrives at `dst: "hub:local"`:

1. The registry looks up the command name in the command table
2. If found, it delivers the message to the owning plugin's `sendFn`
3. If not found, it falls through to built-in hub command handling

The hub's session handler owns all user-facing slash commands. The iTerm2 terminal plugin owns keyboard control commands. Commands from both plugins are registered at daemon startup in `src/daemon/index.ts`.

See [commands.md](./commands.md) for the complete command list.

## Heartbeat and Health Monitoring

The registry runs a heartbeat cycle. In the current implementation, adapters send a `ping` IPC call every 30 seconds. The AIBP heartbeat uses SYSTEM/PING messages internally.

### Heartbeat Constants

```typescript
const HEARTBEAT_INTERVAL_MS = 30_000;    // 30 seconds
const HEARTBEAT_MISS_DEGRADED = 3;       // 3 missed → degraded
const HEARTBEAT_MISS_DEAD = 5;           // 5 missed → dead, unregister
```

### Health States

A `RegisteredPlugin` has three possible statuses:

| Status | Meaning | Trigger |
|--------|---------|---------|
| `active` | Plugin is responding normally | Initial state; reset on each PING |
| `degraded` | Plugin has missed 3+ heartbeats | `missedPings >= HEARTBEAT_MISS_DEGRADED` |
| `dead` | Plugin has missed 5+ heartbeats | `missedPings >= HEARTBEAT_MISS_DEAD` |

When a plugin reaches `dead` status, `registry.unregister()` is called automatically. All channels are parted, commands are removed, and a `PLUGIN_OFFLINE` system event is broadcast to all remaining plugins.

### PING/PONG Flow

```
Plugin                          Registry
  │                                │
  │── SYSTEM/PING ──────────────►  │
  │                                │  Reset missedPings
  │                                │  Set status: "active"
  │◄─ SYSTEM/PONG ─────────────── │
```

When `heartbeatCheck()` is called (periodically by the daemon), the registry increments `missedPings` for every registered plugin. A plugin that sends PING before the next check resets its counter to 0.

## Plugin Lifecycle

```
                    ┌────────────┐
                    │   absent   │
                    └─────┬──────┘
                          │ register()
                          ▼
                    ┌────────────┐
            ┌──────►│   active   │◄──────┐
            │       └─────┬──────┘       │
            │  PING        │ miss×3       │ PING
            │             ▼              │
            │       ┌────────────┐       │
            │       │  degraded  │───────┘
            │       └─────┬──────┘
            │              │ miss×5
            │             ▼
            │       ┌────────────┐
            │       │    dead    │
            │       └─────┬──────┘
            │              │ unregister()
            │             ▼
            │       ┌────────────┐
            └───────│  absent    │
                    └────────────┘
                   (reconnect triggers re-register)
```

## The RegisteredPlugin Record

The hub stores a `RegisteredPlugin` for each connected plugin:

```typescript
interface RegisteredPlugin {
  spec: PluginSpec;          // Original registration spec
  address: string;           // Resolved address (e.g., "transport:whazaa")
  connectedAt: number;       // Unix timestamp of registration
  lastPing?: number;         // Timestamp of last PING received
  missedPings: number;       // Counter reset by each PING
  status: "active" | "degraded" | "dead";
  joinedChannels: Set<string>; // Current channel memberships
}
```

## Querying Plugin State

The registry provides several query methods used by the `aibroker_aibp_status` MCP tool and the hub's `aibp_status` IPC handler:

```typescript
registry.getPlugin(address)          // → RegisteredPlugin | undefined
registry.getChannel(channel)         // → ChannelMembership | undefined
registry.getPluginByType(type)       // → RegisteredPlugin[]
registry.getCommandOwner(command)    // → plugin address | undefined
registry.listPlugins()               // → RegisteredPlugin[]
registry.listChannels()              // → ChannelMembership[]
registry.listCommands()              // → { name, owner, spec }[]
```

These are also accessible through `AibpBridge`:

```typescript
aibpBridge.listPlugins()             // → plugin addresses
aibpBridge.getChannelInfo(channel)   // → ChannelMembership | undefined
aibpBridge.listCommands()            // → { name, owner, spec }[]
aibpBridge.getCommandOwner(command)  // → plugin address | undefined
aibpBridge.listPeers()               // → remote hub IDs (bridge plugins)
```
