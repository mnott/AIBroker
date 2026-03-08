# Protocol Landscape: Where AIBP Fits

## The Three-Layer Consensus

The AI agent communication space is converging on a three-layer architecture:

| Layer | Protocol | Purpose | Status |
|-------|----------|---------|--------|
| Layer 1 | **MCP** (Anthropic) | Tool access — how an agent calls external capabilities | Widely adopted, de facto standard |
| Layer 2 | **A2A** (Google) | Agent delegation — how one agent asks another to do work | Released April 2025, 50+ partners |
| Layer 3 | **AIBP** (AIBroker) | Channel routing — how messages flow between plugins, sessions, devices, and machines | In production |

## Protocol Survey

### MCP (Model Context Protocol) — Anthropic
- **What**: Standardized interface for AI models to call external tools and read resources
- **Model**: Client-server. The AI model is the client, tools are servers.
- **Strengths**: Simple, widely adopted, great tooling ecosystem
- **Limitations**: No agent-to-agent communication. No routing. No channels. Single-hop only.
- **AIBP relationship**: AIBP uses MCP as its Layer 1. MCP plugins register in the AIBP registry and route messages through AIBP channels.

### A2A (Agent-to-Agent Protocol) — Google
- **What**: Protocol for agent delegation and task lifecycle management
- **Spec**: https://a2a-protocol.org/latest/specification/
- **Key concepts**: Agent Cards (JSON metadata for discovery, like DNS SRV records), Tasks (with lifecycle: submitted → working → completed/failed), Streaming via SSE
- **Model**: Request/response with streaming. One agent delegates a task to another.
- **Strengths**: Strong industry backing (50+ partners including Salesforce, SAP, MongoDB). Well-specified task lifecycle. Agent Cards enable discovery.
- **Limitations**: Point-to-point only — no channel fan-out. No native multi-hop/mesh routing. No session awareness. No plugin type system.
- **AIBP relationship**: A2A could serve as AIBP's external delegation protocol. An A2A compatibility facade would let AIBP plugins be discoverable as A2A agents.

### ANP (Agent Network Protocol)
- **What**: Decentralized agent communication using DID (Decentralized Identifiers)
- **Key concepts**: DID-based identity, decentralized discovery, cryptographic authentication
- **Status**: Academic/early stage. Research project, not production-ready.
- **AIBP relationship**: ANP's DID approach could inform AIBP's future identity model for mesh networking.

### NANDA — MIT
- **What**: "Internet of Agents" — a registry and discovery system for AI agents
- **Status**: Research project. Interesting conceptually but not widely adopted.
- **AIBP relationship**: NANDA's registry concept parallels AIBP's PluginRegistry but at internet scale.

### n8n
- **What**: Workflow orchestration platform with visual node editor
- **Model**: Static DAG (directed acyclic graph) of processing nodes. Not a protocol.
- **Strengths**: Great UI, large integration library, self-hostable
- **Limitations**: Nodes are statically wired at design time, not dynamically routed. No agent autonomy — workflows are deterministic pipelines.
- **AIBP relationship**: None directly. n8n is an orchestration tool, AIBP is a routing protocol. They operate at different levels.

### LMOS (Large Model Operating System)
- **What**: Eclipse Foundation project for agent runtime and communication
- **Status**: Early stage, enterprise-focused
- **AIBP relationship**: Similar goals at a higher abstraction level. Worth monitoring.

## What Makes AIBP Different

### 1. Channel Fan-Out (IRC Model)
A2A is point-to-point: Agent A → Agent B. AIBP has channels: a message sent to `session:abc` reaches ALL plugins joined to that channel. This is how PAILot, the terminal plugin, and MCP sessions all stay synchronized.

```
A2A:  Agent A ──request──▶ Agent B
AIBP: Plugin A ──message──▶ #session:abc ──fan-out──▶ Plugin B, Plugin C, Plugin D
```

### 2. Typed Plugin Registry
Every AIBP plugin declares its type (transport, terminal, mobile, bridge, mcp, hub) and capabilities (TEXT, VOICE, IMAGE, COMMAND, FILE). The registry uses this for intelligent routing.

### 3. Mesh Addressing
`hub:remote-name/session:abc` routes a message from the local hub to a specific session on a remote hub. Multi-hop routing across machines with explicit addressing.

### 4. Session Awareness
Messages carry session context. The protocol knows which Claude Code session a message belongs to. No other agent protocol has this concept.

### 5. Heterogeneous Plugin Types
AIBP routes between fundamentally different plugin types in a single protocol:
- WhatsApp/Telegram transports
- iTerm2 terminal sessions
- Mobile WebSocket clients (PAILot)
- MCP tool servers
- Remote hubs (mesh)

A2A assumes all participants are "agents" with similar capabilities. AIBP handles the real-world diversity of an AI infrastructure stack.

## Strategic Position

```
┌─────────────────────────────────────┐
│  Layer 3: AIBP                      │
│  Channel routing, mesh, plugin      │
│  registry, session management       │
├─────────────────────────────────────┤
│  Layer 2: A2A (future facade)       │
│  Agent delegation, task lifecycle,  │
│  discovery via Agent Cards          │
├─────────────────────────────────────┤
│  Layer 1: MCP (in use)              │
│  Tool access, resource reading      │
└─────────────────────────────────────┘
```

## Recommendations

1. **Keep MCP as Layer 1** — already integrated, working well
2. **Consider A2A facade later** — expose AIBP plugins as Agent Cards for external discovery. Map A2A task lifecycle to AIBP message flows. This is a compatibility layer, not a replacement.
3. **AIBP's channel model is the unique value** — don't flatten it to match A2A's request/response pattern. Channels with fan-out solve a class of problems (multi-client sync, session broadcasting) that point-to-point protocols can't.
4. **Watch ANP for identity** — DID-based identity could strengthen AIBP mesh networking authentication
5. **Ignore n8n as a protocol competitor** — it's an orchestration UI, not a communication standard

## Further Reading

- [A2A Protocol Specification](https://a2a-protocol.org/latest/specification/)
- [MCP Specification](https://modelcontextprotocol.io/)
- [Agent Communication Protocols Overview](https://agent-network-protocol.com/blogs/posts/agent-communication-protocol-comparison)
- AIBP Protocol Spec: [protocol.md](./protocol.md)
- AIBP Architecture: [architecture.md](./architecture.md)
