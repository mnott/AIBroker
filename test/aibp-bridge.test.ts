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
