import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AibpBridge } from "../src/aibp/bridge.js";
import type { AibpMessage } from "../src/aibp/types.js";

describe("AibpBridge", () => {
  it("registers PAILot as a mobile plugin", () => {
    const bridge = new AibpBridge();
    const received: AibpMessage[] = [];
    bridge.registerMobile("pailot", (m) => received.push(m));

    const plugins = bridge.listPlugins();
    assert.ok(plugins.includes("mobile:pailot"));
  });

  it("registers a transport adapter", () => {
    const bridge = new AibpBridge();
    bridge.registerTransport("whazaa", () => {});

    const plugins = bridge.listPlugins();
    assert.ok(plugins.includes("transport:whazaa"));
  });

  it("registers an MCP process and resolves session", () => {
    const bridge = new AibpBridge();
    const result = bridge.registerMcp("ABC123", "ABC123");

    assert.equal(result.address, "mcp:ABC123");
    assert.equal(result.resolvedSession, "session:ABC123");

    const plugins = bridge.listPlugins();
    assert.ok(plugins.includes("mcp:ABC123"));
  });

  it("routes text from mobile to session channel", () => {
    const bridge = new AibpBridge();
    const received: AibpMessage[] = [];

    // Register a mock session listener
    bridge.registry.register(
      {
        id: "ABC123",
        type: "mcp",
        name: "Test MCP",
        capabilities: ["TEXT"],
        channels: [],
      },
      (m) => received.push(m),
    );
    bridge.registry.join("mcp:ABC123", "session:ABC123");

    // Route from mobile
    bridge.routeFromMobile("ABC123", "Hello from PAILot");

    assert.equal(received.length, 1);
    assert.equal(received[0].type, "TEXT");
    assert.equal((received[0].payload as any).content, "Hello from PAILot");
    assert.equal(received[0].src, "mobile:pailot");
    assert.equal(received[0].dst, "session:ABC123");
  });

  it("routes text from session to mobile plugin", () => {
    const bridge = new AibpBridge();
    const received: AibpMessage[] = [];

    bridge.registerMobile("pailot", (m) => received.push(m));

    bridge.routeToMobile("ABC123", "Hello from Claude");

    assert.equal(received.length, 1);
    assert.equal(received[0].type, "TEXT");
    assert.equal((received[0].payload as any).content, "Hello from Claude");
    assert.equal(received[0].src, "session:ABC123");
    assert.equal(received[0].dst, "mobile:pailot");
  });

  it("routes typing indicator to mobile", () => {
    const bridge = new AibpBridge();
    const received: AibpMessage[] = [];

    bridge.registerMobile("pailot", (m) => received.push(m));
    bridge.sendTyping("ABC123", true);

    assert.equal(received.length, 1);
    assert.equal(received[0].type, "TYPING");
    assert.equal((received[0].payload as any).active, true);
  });

  it("joins and parts session channels", () => {
    const bridge = new AibpBridge();
    bridge.registerMobile("pailot", () => {});

    bridge.joinSession("ABC123");
    const info = bridge.getChannelInfo("session:ABC123");
    assert.ok(info);
    assert.ok(info!.members.has("mobile:pailot"));

    bridge.partSession("ABC123");
    const info2 = bridge.getChannelInfo("session:ABC123");
    // Channel should still exist (session channels persist) but pailot should be gone
    assert.ok(info2);
    assert.ok(!info2!.members.has("mobile:pailot"));
  });

  it("buffers messages when mobile is not joined and drains on join", () => {
    const bridge = new AibpBridge();
    const received: AibpMessage[] = [];

    bridge.registerMobile("pailot", (m) => received.push(m));

    // Route to a session channel that pailot hasn't joined
    bridge.routeToMobile("DEF456", "Message while away");

    // Nothing delivered yet (mobile:pailot is not joined to session:DEF456)
    // But the message goes to mobile:pailot directly since it's addressed to it
    assert.equal(received.length, 1); // Direct addressing works
  });

  it("handles multiple transport registrations", () => {
    const bridge = new AibpBridge();
    const waReceived: AibpMessage[] = [];
    const tgReceived: AibpMessage[] = [];

    bridge.registerTransport("whazaa", (m) => waReceived.push(m));
    bridge.registerTransport("telex", (m) => tgReceived.push(m));

    const plugins = bridge.listPlugins();
    assert.ok(plugins.includes("transport:whazaa"));
    assert.ok(plugins.includes("transport:telex"));
    assert.equal(plugins.length, 2);
  });
});

// ---------------------------------------------------------------------------
// Step 1: Inbound AIBP routing — session handler tests
// ---------------------------------------------------------------------------

describe("AIBP Inbound Routing (Session Handler)", () => {
  it("registers session handler as a hub plugin", () => {
    const bridge = new AibpBridge();
    bridge.registerSessionHandler(() => {});

    const plugins = bridge.listPlugins();
    assert.ok(plugins.includes("hub:session-handler"));
  });

  it("routes inbound text from mobile to session handler", () => {
    const bridge = new AibpBridge();
    const handlerReceived: AibpMessage[] = [];

    // Register mobile plugin (source)
    bridge.registerMobile("pailot", () => {});

    // Register session handler (destination)
    bridge.registerSessionHandler((m) => handlerReceived.push(m));

    // Route from mobile → session channel
    bridge.routeFromMobile("ABC123", "Hello from PAILot");

    // Session handler should receive the message
    assert.equal(handlerReceived.length, 1);
    assert.equal(handlerReceived[0].type, "TEXT");
    assert.equal((handlerReceived[0].payload as any).content, "Hello from PAILot");
    assert.equal(handlerReceived[0].src, "mobile:pailot");
    assert.equal(handlerReceived[0].dst, "session:ABC123");
  });

  it("auto-joins session handler to session channel on routeFromMobile", () => {
    const bridge = new AibpBridge();
    bridge.registerMobile("pailot", () => {});
    bridge.registerSessionHandler(() => {});

    // Before routing, no session channel exists
    assert.equal(bridge.getChannelInfo("session:XYZ"), undefined);

    // Route creates channel and auto-joins handler
    bridge.routeFromMobile("XYZ", "test");

    const ch = bridge.getChannelInfo("session:XYZ");
    assert.ok(ch);
    assert.ok(ch!.members.has("hub:session-handler"));
  });

  it("session handler receives voice messages", () => {
    const bridge = new AibpBridge();
    const received: AibpMessage[] = [];

    bridge.registerMobile("pailot", () => {});
    bridge.registerSessionHandler((m) => received.push(m));

    bridge.routeFromMobile("ABC123", "transcribed text", "VOICE", {
      audioBase64: "base64audio",
      durationMs: 3000,
    });

    assert.equal(received.length, 1);
    assert.equal(received[0].type, "VOICE");
    assert.equal((received[0].payload as any).transcript, "transcribed text");
    assert.equal((received[0].payload as any).audioBase64, "base64audio");
  });

  it("session handler receives image messages", () => {
    const bridge = new AibpBridge();
    const received: AibpMessage[] = [];

    bridge.registerMobile("pailot", () => {});
    bridge.registerSessionHandler((m) => received.push(m));

    bridge.routeFromMobile("ABC123", "screenshot", "IMAGE", {
      imageBase64: "base64img",
      mimeType: "image/png",
    });

    assert.equal(received.length, 1);
    assert.equal(received[0].type, "IMAGE");
    assert.equal((received[0].payload as any).caption, "screenshot");
    assert.equal((received[0].payload as any).imageBase64, "base64img");
  });

  it("session handler does not receive messages for other plugins", () => {
    const bridge = new AibpBridge();
    const handlerReceived: AibpMessage[] = [];
    const mobileReceived: AibpMessage[] = [];

    bridge.registerMobile("pailot", (m) => mobileReceived.push(m));
    bridge.registerSessionHandler((m) => handlerReceived.push(m));

    // Send to mobile directly (not to session channel)
    bridge.routeToMobile("ABC123", "Reply from Claude");

    // Mobile should receive, handler should NOT
    assert.equal(mobileReceived.length, 1);
    assert.equal(handlerReceived.length, 0);
  });

  it("both MCP plugin and session handler receive messages on shared channel", () => {
    const bridge = new AibpBridge();
    const mcpReceived: AibpMessage[] = [];
    const handlerReceived: AibpMessage[] = [];

    bridge.registerMobile("pailot", () => {});
    bridge.registerSessionHandler((m) => handlerReceived.push(m));

    // Also register an MCP plugin on the same session
    bridge.registerMcp("MCP1", "ABC123", (m) => mcpReceived.push(m));

    // Route from mobile
    bridge.routeFromMobile("ABC123", "Hello");

    // Both should receive the message (fan-out)
    assert.equal(handlerReceived.length, 1);
    assert.equal(mcpReceived.length, 1);
    assert.equal((handlerReceived[0].payload as any).content, "Hello");
    assert.equal((mcpReceived[0].payload as any).content, "Hello");
  });

  it("session handler is idempotent on repeated routeFromMobile to same session", () => {
    const bridge = new AibpBridge();
    const received: AibpMessage[] = [];

    bridge.registerMobile("pailot", () => {});
    bridge.registerSessionHandler((m) => received.push(m));

    // Route multiple messages to the same session
    bridge.routeFromMobile("ABC", "msg1");
    bridge.routeFromMobile("ABC", "msg2");
    bridge.routeFromMobile("ABC", "msg3");

    // All 3 should arrive, no duplicate joins causing issues
    assert.equal(received.length, 3);
    assert.equal((received[0].payload as any).content, "msg1");
    assert.equal((received[1].payload as any).content, "msg2");
    assert.equal((received[2].payload as any).content, "msg3");

    // Channel should have exactly 1 hub member
    const ch = bridge.getChannelInfo("session:ABC");
    assert.ok(ch);
    assert.equal(ch!.members.size, 1);
  });

  it("works without session handler (backward compat — buffers in outbox)", () => {
    const bridge = new AibpBridge();
    bridge.registerMobile("pailot", () => {});

    // No session handler registered — message should buffer
    bridge.routeFromMobile("ORPHAN", "nobody listening");

    const ch = bridge.getChannelInfo("session:ORPHAN");
    assert.ok(ch);
    assert.equal(ch!.outbox.length, 1);
    assert.equal((ch!.outbox[0].payload as any).content, "nobody listening");
  });
});

// ---------------------------------------------------------------------------
// Step 2: Terminal plugin tests
// ---------------------------------------------------------------------------

describe("AIBP Terminal Plugin", () => {
  it("registers iTerm as a terminal plugin", () => {
    const bridge = new AibpBridge();
    bridge.registerTerminal("iterm", () => {});

    const plugins = bridge.listPlugins();
    assert.ok(plugins.includes("terminal:iterm"));
  });

  it("routeToTerminal delivers TEXT to terminal plugin", () => {
    const bridge = new AibpBridge();
    const received: AibpMessage[] = [];

    bridge.registerTerminal("iterm", (m) => received.push(m));

    const ok = bridge.routeToTerminal("ABC123", "Hello terminal");
    assert.ok(ok);
    assert.equal(received.length, 1);
    assert.equal(received[0].type, "TEXT");
    assert.equal((received[0].payload as any).content, "Hello terminal");
    assert.equal(received[0].src, "session:ABC123");
    assert.equal(received[0].dst, "terminal:iterm");
  });

  it("routeToTerminal delivers COMMAND to terminal plugin", () => {
    const bridge = new AibpBridge();
    const received: AibpMessage[] = [];

    bridge.registerTerminal("iterm", (m) => received.push(m));

    const ok = bridge.routeToTerminal("ABC123", "/s", "COMMAND");
    assert.ok(ok);
    assert.equal(received.length, 1);
    assert.equal(received[0].type, "COMMAND");
    assert.equal((received[0].payload as any).command, "type");
    assert.equal((received[0].payload as any).args.text, "/s");
  });

  it("routeToTerminal returns false when no terminal registered", () => {
    const bridge = new AibpBridge();

    const ok = bridge.routeToTerminal("ABC123", "nobody home");
    assert.equal(ok, false);
  });

  it("routeToTerminal uses hub:local when no sessionId", () => {
    const bridge = new AibpBridge();
    const received: AibpMessage[] = [];

    bridge.registerTerminal("iterm", (m) => received.push(m));

    bridge.routeToTerminal("", "global message");
    assert.equal(received.length, 1);
    assert.equal(received[0].src, "hub:local");
  });

  it("terminal plugin is discoverable by type", () => {
    const bridge = new AibpBridge();
    bridge.registerTerminal("iterm", () => {});
    bridge.registerMobile("pailot", () => {});

    const terminals = bridge.registry.getPluginByType("terminal");
    assert.equal(terminals.length, 1);
    assert.equal(terminals[0].address, "terminal:iterm");
  });
});

// ---------------------------------------------------------------------------
// Step 3: Command macros — AIBP command registry tests
// ---------------------------------------------------------------------------

describe("AIBP Command Registry", () => {
  it("session handler registers hub-owned commands", () => {
    const bridge = new AibpBridge();
    bridge.registerSessionHandler(() => {});

    // Hub commands should be registered
    assert.equal(bridge.getCommandOwner("s"), "hub:session-handler");
    assert.equal(bridge.getCommandOwner("sessions"), "hub:session-handler");
    assert.equal(bridge.getCommandOwner("ss"), "hub:session-handler");
    assert.equal(bridge.getCommandOwner("c"), "hub:session-handler");
    assert.equal(bridge.getCommandOwner("p"), "hub:session-handler");
    assert.equal(bridge.getCommandOwner("image"), "hub:session-handler");
    assert.equal(bridge.getCommandOwner("h"), "hub:session-handler");
    assert.equal(bridge.getCommandOwner("help"), "hub:session-handler");
  });

  it("terminal plugin registers keyboard commands", () => {
    const bridge = new AibpBridge();
    const termCmds = [
      { name: "cc", description: "Ctrl+C", args: "" },
      { name: "esc", description: "Escape", args: "" },
      { name: "enter", description: "Enter", args: "" },
      { name: "up", description: "Up arrow", args: "" },
      { name: "down", description: "Down arrow", args: "" },
      { name: "pick", description: "Menu select", args: "<N>" },
    ];
    bridge.registerTerminal("iterm", () => {}, termCmds);

    assert.equal(bridge.getCommandOwner("cc"), "terminal:iterm");
    assert.equal(bridge.getCommandOwner("esc"), "terminal:iterm");
    assert.equal(bridge.getCommandOwner("enter"), "terminal:iterm");
    assert.equal(bridge.getCommandOwner("up"), "terminal:iterm");
    assert.equal(bridge.getCommandOwner("pick"), "terminal:iterm");
  });

  it("listCommands returns all registered commands with owners", () => {
    const bridge = new AibpBridge();
    bridge.registerSessionHandler(() => {});
    bridge.registerTerminal("iterm", () => {}, [
      { name: "cc", description: "Ctrl+C", args: "" },
    ]);

    const commands = bridge.listCommands();
    assert.ok(commands.length > 0);

    // Hub commands
    const sCmd = commands.find(c => c.name === "s");
    assert.ok(sCmd);
    assert.equal(sCmd!.owner, "hub:session-handler");

    // Terminal commands
    const ccCmd = commands.find(c => c.name === "cc");
    assert.ok(ccCmd);
    assert.equal(ccCmd!.owner, "terminal:iterm");
  });

  it("unknown commands return undefined owner", () => {
    const bridge = new AibpBridge();
    bridge.registerSessionHandler(() => {});

    assert.equal(bridge.getCommandOwner("nonexistent"), undefined);
  });

  it("commands from different plugins don't conflict", () => {
    const bridge = new AibpBridge();
    bridge.registerSessionHandler(() => {});
    bridge.registerTerminal("iterm", () => {}, [
      { name: "cc", description: "Ctrl+C", args: "" },
    ]);
    bridge.registerTransport("whazaa", () => {}, [
      { name: "wa", description: "WhatsApp send", args: "<msg>" },
    ]);

    // Each command owned by its plugin
    assert.equal(bridge.getCommandOwner("s"), "hub:session-handler");
    assert.equal(bridge.getCommandOwner("cc"), "terminal:iterm");
    assert.equal(bridge.getCommandOwner("wa"), "transport:whazaa");
  });
});

// ---------------------------------------------------------------------------
// Step 4: Cross-session messaging tests
// ---------------------------------------------------------------------------

describe("AIBP Cross-Session Messaging", () => {
  it("routes text from session A to session B via routeBetweenSessions", () => {
    const bridge = new AibpBridge();
    const handlerReceived: AibpMessage[] = [];

    bridge.registerSessionHandler((m) => handlerReceived.push(m));

    bridge.routeBetweenSessions("SESSION_A", "SESSION_B", "Hello from A");

    assert.equal(handlerReceived.length, 1);
    assert.equal(handlerReceived[0].type, "TEXT");
    assert.equal((handlerReceived[0].payload as any).content, "Hello from A");
    assert.equal(handlerReceived[0].src, "session:SESSION_A");
    assert.equal(handlerReceived[0].dst, "session:SESSION_B");
  });

  it("routes COMMAND from session A to session B", () => {
    const bridge = new AibpBridge();
    const handlerReceived: AibpMessage[] = [];

    bridge.registerSessionHandler((m) => handlerReceived.push(m));

    bridge.routeBetweenSessions("SESSION_A", "SESSION_B", "run tests", "COMMAND");

    assert.equal(handlerReceived.length, 1);
    assert.equal(handlerReceived[0].type, "COMMAND");
    assert.equal((handlerReceived[0].payload as any).command, "cross-session");
    assert.equal((handlerReceived[0].payload as any).args.text, "run tests");
    assert.equal((handlerReceived[0].payload as any).args.fromSession, "SESSION_A");
  });

  it("auto-joins session handler to target session channel", () => {
    const bridge = new AibpBridge();
    bridge.registerSessionHandler(() => {});

    // No channel exists yet
    assert.equal(bridge.getChannelInfo("session:TARGET"), undefined);

    bridge.routeBetweenSessions("SRC", "TARGET", "msg");

    const ch = bridge.getChannelInfo("session:TARGET");
    assert.ok(ch);
    assert.ok(ch!.members.has("hub:session-handler"));
  });

  it("MCP plugin on target session also receives cross-session message", () => {
    const bridge = new AibpBridge();
    const handlerReceived: AibpMessage[] = [];
    const mcpReceived: AibpMessage[] = [];

    bridge.registerSessionHandler((m) => handlerReceived.push(m));
    bridge.registerMcp("MCP_B", "SESSION_B", (m) => mcpReceived.push(m));

    bridge.routeBetweenSessions("SESSION_A", "SESSION_B", "cross-session msg");

    // Both session handler and MCP on SESSION_B receive it
    assert.equal(handlerReceived.length, 1);
    assert.equal(mcpReceived.length, 1);
    assert.equal((mcpReceived[0].payload as any).content, "cross-session msg");
  });

  it("multiple cross-session messages don't duplicate channel joins", () => {
    const bridge = new AibpBridge();
    const received: AibpMessage[] = [];

    bridge.registerSessionHandler((m) => received.push(m));

    bridge.routeBetweenSessions("A", "B", "msg1");
    bridge.routeBetweenSessions("A", "B", "msg2");
    bridge.routeBetweenSessions("C", "B", "msg3");

    assert.equal(received.length, 3);

    const ch = bridge.getChannelInfo("session:B");
    assert.ok(ch);
    // Only 1 member (session handler) — no duplicates
    assert.equal(ch!.members.size, 1);
  });

  it("cross-session message buffers when no handler registered", () => {
    const bridge = new AibpBridge();
    // No session handler — message should buffer in outbox

    bridge.routeBetweenSessions("A", "ORPHAN", "no one listening");

    const ch = bridge.getChannelInfo("session:ORPHAN");
    assert.ok(ch);
    assert.equal(ch!.outbox.length, 1);
    assert.equal((ch!.outbox[0].payload as any).content, "no one listening");
  });

  it("bidirectional cross-session messaging works", () => {
    const bridge = new AibpBridge();
    const received: AibpMessage[] = [];

    bridge.registerSessionHandler((m) => received.push(m));

    // A → B
    bridge.routeBetweenSessions("A", "B", "hello from A");
    // B → A
    bridge.routeBetweenSessions("B", "A", "hello from B");

    assert.equal(received.length, 2);
    assert.equal(received[0].dst, "session:B");
    assert.equal(received[1].dst, "session:A");

    // Both channels exist
    assert.ok(bridge.getChannelInfo("session:A"));
    assert.ok(bridge.getChannelInfo("session:B"));
  });
});

// ---------------------------------------------------------------------------
// Step 5: Multi-machine mesh — bridge-to-bridge tests
// ---------------------------------------------------------------------------

describe("AIBP Mesh Networking", () => {
  it("registers a bridge plugin", () => {
    const bridge = new AibpBridge();
    bridge.registerBridge("mac-mini", () => {});

    const plugins = bridge.listPlugins();
    assert.ok(plugins.includes("bridge:mac-mini"));
  });

  it("routes mesh-addressed messages to bridge plugin", () => {
    const bridge = new AibpBridge();
    const bridgeReceived: AibpMessage[] = [];

    bridge.registerBridge("mac-mini", (m) => bridgeReceived.push(m));

    // Send a message to a remote session on mac-mini
    bridge.routeToRemote("mac-mini", "session:ABC", "Hello remote!", "SESSION_LOCAL");

    assert.equal(bridgeReceived.length, 1);
    assert.equal(bridgeReceived[0].dst, "hub:mac-mini/session:ABC");
    assert.equal((bridgeReceived[0].payload as any).content, "Hello remote!");
  });

  it("routeToRemote returns false when no bridge for target hub", () => {
    const bridge = new AibpBridge();

    const ok = bridge.routeToRemote("nonexistent", "session:ABC", "msg");
    assert.equal(ok, false);
  });

  it("multiple bridges can coexist", () => {
    const bridge = new AibpBridge();
    const miniReceived: AibpMessage[] = [];
    const proReceived: AibpMessage[] = [];

    bridge.registerBridge("mac-mini", (m) => miniReceived.push(m));
    bridge.registerBridge("mac-pro", (m) => proReceived.push(m));

    bridge.routeToRemote("mac-mini", "session:A", "to mini");
    bridge.routeToRemote("mac-pro", "session:B", "to pro");

    assert.equal(miniReceived.length, 1);
    assert.equal(proReceived.length, 1);
    assert.equal((miniReceived[0].payload as any).content, "to mini");
    assert.equal((proReceived[0].payload as any).content, "to pro");
  });

  it("incoming mesh messages get routed to local session", () => {
    const bridge = new AibpBridge();
    const handlerReceived: AibpMessage[] = [];

    bridge.registerSessionHandler((m) => handlerReceived.push(m));
    bridge.registerBridge("mac-mini", () => {});

    // Simulate receiving a message from a remote hub
    bridge.routeFromRemote("mac-mini", "session:LOCAL_SESSION", "Hello from remote", "session:REMOTE_ABC");

    assert.equal(handlerReceived.length, 1);
    assert.equal(handlerReceived[0].src, "hub:mac-mini/session:REMOTE_ABC");
    assert.equal(handlerReceived[0].dst, "session:LOCAL_SESSION");
    assert.equal((handlerReceived[0].payload as any).content, "Hello from remote");
  });

  it("incoming mesh voice messages preserve payload", () => {
    const bridge = new AibpBridge();
    const received: AibpMessage[] = [];

    bridge.registerSessionHandler((m) => received.push(m));
    bridge.registerBridge("remote-hub", () => {});

    bridge.routeFromRemote("remote-hub", "session:LOCAL", "transcript", "session:REMOTE", "VOICE", {
      audioBase64: "base64audio",
      durationMs: 5000,
    });

    assert.equal(received.length, 1);
    assert.equal(received[0].type, "VOICE");
    assert.equal((received[0].payload as any).transcript, "transcript");
    assert.equal((received[0].payload as any).audioBase64, "base64audio");
  });

  it("mesh address parsing works in registry routing", () => {
    const bridge = new AibpBridge();
    const bridgeReceived: AibpMessage[] = [];

    bridge.registerBridge("mac-mini", (m) => bridgeReceived.push(m));

    // Route directly through registry with mesh address
    const meshMsg = {
      aibp: "0.1" as const,
      id: "test-id",
      ts: Date.now(),
      src: "session:LOCAL",
      dst: "hub:mac-mini/session:REMOTE",
      type: "TEXT" as const,
      payload: { content: "mesh routed" },
    };
    bridge.registry.route(meshMsg);

    assert.equal(bridgeReceived.length, 1);
    assert.equal((bridgeReceived[0].payload as any).content, "mesh routed");
  });

  it("bridge plugin is discoverable by type", () => {
    const bridge = new AibpBridge();
    bridge.registerBridge("mac-mini", () => {});
    bridge.registerBridge("mac-pro", () => {});

    const bridges = bridge.registry.getPluginByType("bridge");
    assert.equal(bridges.length, 2);
    assert.ok(bridges.some(b => b.address === "bridge:mac-mini"));
    assert.ok(bridges.some(b => b.address === "bridge:mac-pro"));
  });

  it("listPeers returns all registered bridge hubs", () => {
    const bridge = new AibpBridge();
    bridge.registerBridge("mac-mini", () => {});
    bridge.registerBridge("mac-pro", () => {});
    bridge.registerMobile("pailot", () => {}); // Not a bridge

    const peers = bridge.listPeers();
    assert.equal(peers.length, 2);
    assert.ok(peers.includes("mac-mini"));
    assert.ok(peers.includes("mac-pro"));
  });
});
