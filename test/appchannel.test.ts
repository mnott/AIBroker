import { describe, it, expect, vi, afterEach } from "vitest";
import { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import { parseClientFrame, formatChannelPrefix, formatInbound, type HubFrame } from "../src/adapters/appchannel/protocol.js";
import { AppChannel } from "../src/adapters/appchannel/channel.js";
import { attachAppChannel, parseTokens } from "../src/adapters/appchannel/server.js";
import { AppChannelClient } from "../src/adapters/appchannel/client.js";
import { deliveryFor } from "../src/daemon/ingress.js";

const hello = { v: 1 as const, type: "hello" as const, app: "CaseLeaf", paneId: "p1", token: "secret" };
function conn() { const sent: HubFrame[] = []; return { sent, send: (f: HubFrame) => { sent.push(f); } }; }
function mk(opts: { sessions?: string[]; now?: () => number; actionTtlMs?: number; rateLimit?: number } = {}) {
  const deliver = vi.fn();
  const ch = new AppChannel(
    { deliver, sessionExists: (id) => (opts.sessions ?? ["s1", "s2"]).includes(id), now: opts.now },
    { tokens: { CaseLeaf: ["secret"] }, actionTtlMs: opts.actionTtlMs, rateLimit: opts.rateLimit },
  );
  return { ch, deliver };
}
const msg = (session = "s1", text = "hi", context?: any) => ({ v: 1 as const, type: "message" as const, id: "m1", session, text, context });
const pane = (ch: AppChannel, c = conn(), h = hello) => ({ c, p: ch.registerPane(c, h)! });

describe("protocol", () => {
  it("accepts valid frames", () => {
    expect(parseClientFrame(JSON.stringify(hello)).ok).toBe(true);
    expect(parseClientFrame(JSON.stringify({ v: 1, type: "ping" })).ok).toBe(true);
    expect(parseClientFrame(JSON.stringify({ v: 1, type: "confirm", actionId: "a", approve: false })).ok).toBe(true);
    expect(parseClientFrame(JSON.stringify(msg("s", "t", { doc: { fileId: "f", page: 3, marks: ["a"] } }))).ok).toBe(true);
  });
  it("rejects bad input", () => {
    const bad = (x: unknown) => expect(parseClientFrame(typeof x === "string" ? x : JSON.stringify(x)).ok).toBe(false);
    bad("not json");
    bad("[]");
    bad({ v: 2, type: "ping" });
    bad({ v: 1, type: "nope" });
    bad({ v: 1, type: "hello", app: "x" });
    bad({ v: 1, type: "message", id: 1, session: "s", text: "t" });
    bad({ v: 1, type: "confirm", actionId: "a", approve: "yes" });
    bad(msg("s", "x".repeat(70_000)));
    bad(msg("s", "t", { doc: { fileId: "f", selection: "x".repeat(8193) } }));
    bad(msg("s", "t", { doc: { fileId: "f", marks: Array(201).fill("m") } }));
    bad(msg("s", "t", { doc: { fileId: "f", page: -1 } }));
    bad(msg("s", "t", { doc: {} }));
  });
});

describe("prefix", () => {
  it("formats doc context", () => {
    expect(formatChannelPrefix("CaseLeaf", { doc: { fileId: "f1", page: 3, marks: ["a", "b"], selection: "some text" } }))
      .toBe('[CaseLeaf:doc file=f1 page=3 marks=a,b] "some text" ');
  });
  it("collapses newlines and strips brackets/control chars", () => {
    const out = formatInbound("Case Leaf!]\n", "line1\nline2", {
      doc: { fileId: "f]\n[evil", selection: "a\nb\r\nc\u0007\"] injected" , marks: ["x]y"] },
    });
    expect(out).not.toMatch(/[\n\r\u0007]/);
    expect(out.startsWith("[CaseLeaf:doc file=fevil")).toBe(true);
    expect(out.match(/\]/g)!.length).toBe(2); // prefix close + the quoted selection's own "]" only
    expect(out.endsWith("line1 line2")).toBe(true);
    expect(out).toContain("marks=xy");
  });
});

describe("channel", () => {
  it("rejects bad token, unknown app", () => {
    const { ch } = mk();
    const a = conn(); expect(ch.registerPane(a, { ...hello, token: "nope" })).toBeNull();
    expect(a.sent[0]).toMatchObject({ type: "error", code: "auth" });
    const b = conn(); expect(ch.registerPane(b, { ...hello, app: "Other" })).toBeNull();
    expect(b.sent[0]).toMatchObject({ code: "auth" });
    expect(ch.reply("s1", "x")).toBe(0);
  });
  it("delivers prefixed text and acks", async () => {
    const { ch, deliver } = mk();
    const { c, p } = pane(ch);
    expect(c.sent[0]).toMatchObject({ type: "ready" });
    await ch.handleMessage(p, msg("s1", "check this", { doc: { fileId: "f9", page: 2 } }));
    expect(deliver).toHaveBeenCalledWith("s1", "[CaseLeaf:doc file=f9 page=2] check this");
    expect(c.sent.at(-1)).toEqual({ v: 1, type: "ack", id: "m1" });
  });
  it("unknown session errors", async () => {
    const { ch, deliver } = mk();
    const { c, p } = pane(ch);
    await ch.handleMessage(p, msg("zzz"));
    expect(deliver).not.toHaveBeenCalled();
    expect(c.sent.at(-1)).toMatchObject({ code: "session_not_found" });
  });
  it("routes replies only to the pane that spoke; drops otherwise; expires", async () => {
    let t = 1000;
    const { ch } = mk({ now: () => t });
    const A = pane(ch), B = pane(ch, conn(), { ...hello, paneId: "p2" });
    expect(ch.reply("s1", "nobody")).toBe(0);
    await ch.handleMessage(A.p, msg("s1"));
    expect(ch.reply("s1", "yo")).toBe(1);
    expect(A.c.sent.at(-1)).toMatchObject({ type: "reply", session: "s1", text: "yo" });
    expect(B.c.sent.filter((f) => f.type === "reply")).toHaveLength(0);
    expect(ch.reply("s2", "other")).toBe(0);
    t += 31 * 60_000;
    expect(ch.reply("s1", "late")).toBe(0);
    await ch.handleMessage(A.p, msg("s1")); ch.unregister(A.p);
    expect(ch.reply("s1", "gone")).toBe(0);
  });
  it("action confirm / deny / timeout / wrong pane", async () => {
    vi.useFakeTimers();
    try {
      const { ch } = mk({ actionTtlMs: 1000 });
      const A = pane(ch), B = pane(ch, conn(), { ...hello, paneId: "p2" });
      await ch.handleMessage(A.p, msg("s1"));
      const act = (c: ReturnType<typeof conn>) => c.sent.filter((f) => f.type === "action").at(-1) as any;
      const r1 = ch.requestAction("s1", { kind: "mark", args: { page: 1 } });
      const a1 = act(A.c);
      expect(a1).toMatchObject({ needsConfirm: true, action: { kind: "mark" } });
      expect(act(B.c)).toBeUndefined();
      expect(ch.handleConfirm(B.p, { actionId: a1.actionId, approve: true })).toBe(false);
      expect(B.c.sent.at(-1)).toMatchObject({ code: "unknown_action" });
      expect(ch.handleConfirm(A.p, { actionId: a1.actionId, approve: true })).toBe(true);
      await expect(r1).resolves.toEqual({ approved: true });
      const r2 = ch.requestAction("s1", { kind: "revise", args: {} });
      ch.handleConfirm(A.p, { actionId: act(A.c).actionId, approve: false });
      await expect(r2).resolves.toEqual({ approved: false });
      const r3 = ch.requestAction("s1", { kind: "reply", args: {} });
      vi.advanceTimersByTime(1500);
      await expect(r3).resolves.toEqual({ timeout: true });
    } finally { vi.useRealTimers(); }
  });
  it("rate limits", async () => {
    const { ch, deliver } = mk({ rateLimit: 2 });
    const { c, p } = pane(ch);
    await ch.handleMessage(p, msg()); await ch.handleMessage(p, msg()); await ch.handleMessage(p, msg());
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(c.sent.at(-1)).toMatchObject({ code: "rate_limited" });
  });
});

describe("server + client", () => {
  let wss: WebSocketServer | undefined;
  let client: AppChannelClient | undefined;
  afterEach(() => { client?.close(); wss?.close(); });

  async function up(helloMs = 5000) {
    const { ch, deliver } = mk();
    wss = new WebSocketServer({ port: 0, host: "127.0.0.1", path: "/appchannel", maxPayload: 64 * 1024 });
    attachAppChannel(wss, ch, helloMs);
    await new Promise<void>((r) => wss!.on("listening", () => r()));
    return { ch, deliver, url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/appchannel` };
  }

  it("round trip: message, reply, action+confirm", async () => {
    const { ch, deliver, url } = await up();
    client = new AppChannelClient();
    await client.connect({ url, app: "CaseLeaf", paneId: "p1", token: "secret" });
    const reply = new Promise<any>((r) => client!.onReply(r));
    const action = new Promise<any>((r) => client!.onAction(r));
    client.send("s1", "hello", { doc: { fileId: "f1", page: 1, selection: "sel" } });
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledWith("s1", '[CaseLeaf:doc file=f1 page=1] "sel" hello'));
    expect(ch.reply("s1", "answer")).toBe(1);
    expect(await reply).toMatchObject({ session: "s1", text: "answer" });
    const res = ch.requestAction("s1", { kind: "mark", args: { page: 1 } });
    const a = await action;
    client.confirm(a.actionId, true);
    await expect(res).resolves.toEqual({ approved: true });
  });

  it("rejects bad token", async () => {
    const { url } = await up();
    client = new AppChannelClient();
    await expect(client.connect({ url, app: "CaseLeaf", paneId: "p", token: "bad" })).rejects.toThrow(/auth/);
  });

  it("closes when no hello arrives", async () => {
    const { url } = await up(100);
    const { default: WS } = await import("ws");
    const ws = new WS(url);
    const closed = new Promise<void>((r) => ws.on("close", () => r()));
    await closed;
  });

  it("first frame must be hello", async () => {
    const { url } = await up();
    const { default: WS } = await import("ws");
    const ws = new WS(url);
    const got = new Promise<any>((r) => ws.on("message", (d) => r(JSON.parse(d.toString()))));
    ws.on("open", () => ws.send(JSON.stringify({ v: 1, type: "ping" })));
    expect(await got).toMatchObject({ code: "hello_required" });
  });
});

describe("misc", () => {
  it("parses tokens env", () => { expect(parseTokens("a=1, b=2,bad,=x")).toEqual({ a: ["1"], b: ["2"] }); });
  it("ingress types appchannel", () => { expect(deliveryFor("appchannel")).toBe("type"); });
});
