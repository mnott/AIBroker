import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as envelope from "../src/aibp/envelope.js";
import { PluginRegistry } from "../src/aibp/registry.js";
import type { AibpMessage, PluginSpec } from "../src/aibp/types.js";

// ---------------------------------------------------------------------------
// Envelope tests
// ---------------------------------------------------------------------------

describe("AIBP Envelope", () => {
  it("creates a TEXT message with correct envelope fields", () => {
    const msg = envelope.text("mobile:pailot", "session:ABC123", "Hello");
    assert.equal(msg.aibp, "0.1");
    assert.equal(msg.src, "mobile:pailot");
    assert.equal(msg.dst, "session:ABC123");
    assert.equal(msg.type, "TEXT");
    assert.equal(msg.payload.content, "Hello");
    assert.ok(msg.id.length > 0);
    assert.ok(msg.ts > 0);
  });

  it("creates a VOICE message", () => {
    const msg = envelope.voice("mobile:pailot", "session:ABC", "base64data", "hello world", 2300);
    assert.equal(msg.type, "VOICE");
    assert.equal(msg.payload.audioBase64, "base64data");
    assert.equal(msg.payload.transcript, "hello world");
    assert.equal(msg.payload.durationMs, 2300);
  });

  it("creates an IMAGE message", () => {
    const msg = envelope.image("mobile:pailot", "session:ABC", "imgdata", "image/jpeg", "screenshot");
    assert.equal(msg.type, "IMAGE");
    assert.equal(msg.payload.imageBase64, "imgdata");
    assert.equal(msg.payload.caption, "screenshot");
  });

  it("creates a TYPING message", () => {
    const msg = envelope.typing("session:ABC", "mobile:pailot", true);
    assert.equal(msg.type, "TYPING");
    assert.equal(msg.payload.active, true);
  });

  it("creates a COMMAND message", () => {
    const msg = envelope.command("mcp:ABC", "hub:local", "pailot_send", { message: "hi" });
    assert.equal(msg.type, "COMMAND");
    assert.equal((msg.payload as any).command, "pailot_send");
    assert.deepEqual((msg.payload as any).args, { message: "hi" });
  });

  it("creates a SYSTEM message", () => {
    const msg = envelope.system("hub:local", "transport:whatsapp", "REGISTER_ACK", { hubVersion: "0.1" });
    assert.equal(msg.type, "SYSTEM");
    assert.equal((msg.payload as any).event, "REGISTER_ACK");
  });

  it("serializes to NDJSON", () => {
    const msg = envelope.text("a", "b", "test");
    const line = envelope.serialize(msg);
    assert.ok(line.endsWith("\n"));
    const parsed = JSON.parse(line);
    assert.equal(parsed.payload.content, "test");
  });

  it("parses valid AIBP JSON", () => {
    const msg = envelope.text("a", "b", "test");
    const json = JSON.stringify(msg);
    const parsed = envelope.parse(json);
    assert.ok(parsed);
    assert.equal(parsed!.src, "a");
    assert.equal(parsed!.dst, "b");
  });

  it("returns null for invalid JSON", () => {
    assert.equal(envelope.parse("not json"), null);
    assert.equal(envelope.parse('{"foo": "bar"}'), null);
  });

  it("validates with isAibpMessage", () => {
    const msg = envelope.text("a", "b", "test");
    assert.ok(envelope.isAibpMessage(msg));
    assert.ok(!envelope.isAibpMessage({ foo: "bar" }));
    assert.ok(!envelope.isAibpMessage(null));
    assert.ok(!envelope.isAibpMessage("string"));
  });
});

describe("AIBP Address Helpers", () => {
  it("extracts address type", () => {
    assert.equal(envelope.addressType("session:ABC123"), "session");
    assert.equal(envelope.addressType("transport:whatsapp"), "transport");
    assert.equal(envelope.addressType("hub:local"), "hub");
  });

  it("extracts address value", () => {
    assert.equal(envelope.addressValue("session:ABC123"), "ABC123");
    assert.equal(envelope.addressValue("transport:whatsapp"), "whatsapp");
  });

  it("detects local addresses", () => {
    assert.ok(envelope.isLocal("session:ABC123"));
    assert.ok(!envelope.isLocal("hub:mac-mini/session:DEF456"));
  });

  it("parses mesh addresses", () => {
    const result = envelope.parseMeshAddress("hub:mac-mini/session:DEF456");
    assert.ok(result);
    assert.equal(result!.hub, "hub:mac-mini");
    assert.equal(result!.local, "session:DEF456");
    assert.equal(envelope.parseMeshAddress("session:ABC"), null);
  });
});

// ---------------------------------------------------------------------------
// Plugin Registry tests
// ---------------------------------------------------------------------------

describe("PluginRegistry", () => {
  function makeSpec(overrides: Partial<PluginSpec> = {}): PluginSpec {
    return {
      id: "test",
      type: "transport",
      name: "Test Plugin",
      capabilities: ["TEXT"],
      channels: [],
      ...overrides,
    };
  }

  it("registers a plugin and returns REGISTER_ACK", () => {
    const reg = new PluginRegistry();
    const sent: AibpMessage[] = [];
    const ack = reg.register(makeSpec({ id: "whazaa" }), (m) => sent.push(m));
    assert.equal((ack.payload as any).event, "REGISTER_ACK");
    assert.equal((ack.payload as any).assignedAddress, "transport:whazaa");
  });

  it("rejects duplicate registration", () => {
    const reg = new PluginRegistry();
    reg.register(makeSpec({ id: "whazaa" }), () => {});
    const ack2 = reg.register(makeSpec({ id: "whazaa" }), () => {});
    assert.equal((ack2.payload as any).event, "ERROR");
    assert.equal((ack2.payload as any).code, "REGISTER_REJECTED");
  });

  it("auto-joins declared channels", () => {
    const reg = new PluginRegistry();
    reg.register(makeSpec({ id: "whazaa", channels: ["transport:whatsapp"] }), () => {});
    const ch = reg.getChannel("transport:whatsapp");
    assert.ok(ch);
    assert.ok(ch!.members.has("transport:whazaa"));
  });

  it("registers commands from plugin spec", () => {
    const reg = new PluginRegistry();
    reg.register(
      makeSpec({
        id: "whazaa",
        commands: [{ name: "wa", description: "Send WhatsApp", args: "send <msg>" }],
      }),
      () => {},
    );
    assert.equal(reg.getCommandOwner("wa"), "transport:whazaa");
  });

  it("routes TEXT to direct plugin address", () => {
    const reg = new PluginRegistry();
    const received: AibpMessage[] = [];
    reg.register(makeSpec({ id: "pailot", type: "mobile" }), (m) => received.push(m));
    const msg = envelope.text("session:ABC", "mobile:pailot", "Hello from Claude");
    reg.route(msg);
    assert.equal(received.length, 1);
    assert.equal((received[0].payload as any).content, "Hello from Claude");
  });

  it("fans out channel messages to all members except sender", () => {
    const reg = new PluginRegistry();
    const received1: AibpMessage[] = [];
    const received2: AibpMessage[] = [];
    reg.register(makeSpec({ id: "p1", type: "mobile" }), (m) => received1.push(m));
    reg.register(makeSpec({ id: "p2", type: "transport" }), (m) => received2.push(m));
    reg.join("mobile:p1", "session:ABC");
    reg.join("transport:p2", "session:ABC");

    const msg = envelope.text("mobile:p1", "session:ABC", "broadcast");
    reg.route(msg);

    // p1 (sender) should NOT receive it, p2 should
    assert.equal(received1.length, 0);
    assert.equal(received2.length, 1);
  });

  it("buffers messages for offline channel members", () => {
    const reg = new PluginRegistry();
    // Create a session channel with no members
    const msg = envelope.text("mcp:ABC", "session:ABC", "You there?");
    reg.route(msg);

    const ch = reg.getChannel("session:ABC");
    assert.ok(ch);
    assert.equal(ch!.outbox.length, 1);
  });

  it("drains outbox on JOIN", () => {
    const reg = new PluginRegistry();
    // Buffer a message
    reg.route(envelope.text("mcp:ABC", "session:ABC", "Buffered msg"));

    // Now join — should receive OUTBOX_DRAIN + buffered message
    const received: AibpMessage[] = [];
    reg.register(makeSpec({ id: "pailot", type: "mobile" }), (m) => received.push(m));
    reg.join("mobile:pailot", "session:ABC");

    // Should have: OUTBOX_DRAIN header + the buffered TEXT
    assert.equal(received.length, 2);
    assert.equal((received[0].payload as any).event, "OUTBOX_DRAIN");
    assert.equal(received[1].type, "TEXT");
  });

  it("does not buffer TYPING messages", () => {
    const reg = new PluginRegistry();
    reg.route(envelope.typing("session:ABC", "session:ABC", true));
    const ch = reg.getChannel("session:ABC");
    assert.ok(ch);
    assert.equal(ch!.outbox.length, 0);
  });

  it("unregisters plugin and notifies others", () => {
    const reg = new PluginRegistry();
    const notifications: AibpMessage[] = [];
    reg.register(makeSpec({ id: "p1", type: "mobile" }), () => {});
    reg.register(makeSpec({ id: "p2", type: "transport" }), (m) => notifications.push(m));

    reg.unregister("mobile:p1", "crash");

    assert.equal(reg.getPlugin("mobile:p1"), undefined);
    assert.equal(notifications.length, 1);
    assert.equal((notifications[0].payload as any).event, "PLUGIN_OFFLINE");
    assert.equal((notifications[0].payload as any).plugin, "mobile:p1");
  });

  it("lists plugins and channels", () => {
    const reg = new PluginRegistry();
    reg.register(makeSpec({ id: "whazaa", channels: ["transport:whatsapp"] }), () => {});
    reg.register(makeSpec({ id: "pailot", type: "mobile", channels: [] }), () => {});

    assert.equal(reg.listPlugins().length, 2);
    assert.equal(reg.listChannels().length, 1);
  });

  it("handles hub commands", () => {
    const reg = new PluginRegistry();
    const received: AibpMessage[] = [];
    reg.register(makeSpec({ id: "cli", type: "terminal" }), (m) => received.push(m));

    // Route a list_plugins command
    reg.route(envelope.command("terminal:cli", "hub:local", "list_plugins"));
    assert.equal(received.length, 1);
    assert.ok((received[0].payload as any).plugins);
  });

  it("routes commands to owning plugin", () => {
    const reg = new PluginRegistry();
    const waReceived: AibpMessage[] = [];
    reg.register(
      makeSpec({
        id: "whazaa",
        commands: [{ name: "wa", description: "WhatsApp", args: "send" }],
      }),
      (m) => waReceived.push(m),
    );

    reg.route(envelope.command("session:ABC", "hub:local", "wa", { action: "send" }));
    assert.equal(waReceived.length, 1);
    assert.equal((waReceived[0].payload as any).command, "wa");
  });

  it("resolves address by plugin type", () => {
    const reg = new PluginRegistry();
    reg.register(makeSpec({ id: "whazaa", type: "transport" }), () => {});
    reg.register(makeSpec({ id: "pailot", type: "mobile" }), () => {});
    reg.register(makeSpec({ id: "ABC123", type: "mcp" }), () => {});

    const transports = reg.getPluginByType("transport");
    assert.equal(transports.length, 1);
    assert.equal(transports[0].address, "transport:whazaa");

    const mcps = reg.getPluginByType("mcp");
    assert.equal(mcps.length, 1);
    assert.equal(mcps[0].address, "mcp:ABC123");
  });
});
