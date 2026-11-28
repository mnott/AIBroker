import "./home-guard.js";
import { describe, it, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import { parseClientFrame, formatChannelPrefix, formatInbound, type HubFrame } from "../src/adapters/appchannel/protocol.js";
import { AppChannel } from "../src/adapters/appchannel/channel.js";
import { attachAppChannel, parseTokens } from "../src/adapters/appchannel/server.js";
import { AppChannelClient } from "../src/adapters/appchannel/client.js";
import { deliveryFor } from "../src/daemon/ingress.js";

// toMatchObject equivalent: every key in `exp` must match recursively in `act`.
function subset(act: any, exp: any): boolean {
  if (exp === null || typeof exp !== "object") return Object.is(act, exp);
  if (act === null || typeof act !== "object") return false;
  return Object.keys(exp).every((k) => subset(act[k], exp[k]));
}
function match(act: unknown, exp: object) { assert.ok(subset(act, exp), `expected ${JSON.stringify(act)} to match ${JSON.stringify(exp)}`); }
async function waitFor(fn: () => void, ms = 2000) {
  const end = Date.now() + ms;
  for (;;) { try { fn(); return; } catch (e) { if (Date.now() > end) throw e; await new Promise((r) => setTimeout(r, 10)); } }
}

const hello = { v: 1 as const, type: "hello" as const, app: "CaseLeaf", paneId: "p1", token: "secret" };
function conn() { const sent: HubFrame[] = []; return { sent, send: (f: HubFrame) => { sent.push(f); } }; }
function mk(opts: { sessions?: string[]; now?: () => number; actionTtlMs?: number; rateLimit?: number } = {}) {
  const deliver = mock.fn();
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
    assert.equal(parseClientFrame(JSON.stringify(hello)).ok, true);
    assert.equal(parseClientFrame(JSON.stringify({ v: 1, type: "ping" })).ok, true);
    assert.equal(parseClientFrame(JSON.stringify({ v: 1, type: "confirm", actionId: "a", approve: false })).ok, true);
    assert.equal(parseClientFrame(JSON.stringify(msg("s", "t", { doc: { fileId: "f", page: 3, marks: ["a"] } }))).ok, true);
  });
  it("rejects bad input", () => {
    const bad = (x: unknown) => assert.equal(parseClientFrame(typeof x === "string" ? x : JSON.stringify(x)).ok, false);
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
    assert.equal(formatChannelPrefix("CaseLeaf", { doc: { fileId: "f1", page: 3, marks: ["a", "b"], selection: "some text" } }),
      '[CaseLeaf:doc file=f1 page=3 marks=a,b] "some text" ');
  });
  it("collapses newlines and strips brackets/control chars", () => {
    const out = formatInbound("Case Leaf!]\n", "line1\nline2", {
      doc: { fileId: "f]\n[evil", selection: "a\nb\r\nc\u0007\"] injected" , marks: ["x]y"] },
    });
    assert.doesNotMatch(out, /[\n\r\u0007]/);
    assert.equal(out.startsWith("[CaseLeaf:doc file=fevil"), true);
    assert.equal(out.match(/\]/g)!.length, 2); // prefix close + the quoted selection's own "]" only
    assert.equal(out.endsWith("line1 line2"), true);
    assert.ok(out.includes("marks=xy"));
  });
});

describe("channel", () => {
  it("rejects bad token, unknown app", () => {
    const { ch } = mk();
    const a = conn(); assert.equal(ch.registerPane(a, { ...hello, token: "nope" }), null);
    match(a.sent[0], { type: "error", code: "auth" });
    const b = conn(); assert.equal(ch.registerPane(b, { ...hello, app: "Other" }), null);
    match(b.sent[0], { code: "auth" });
    assert.equal(ch.reply("s1", "x"), 0);
  });
  it("delivers prefixed text and acks", async () => {
    const { ch, deliver } = mk();
    const { c, p } = pane(ch);
    match(c.sent[0], { type: "ready" });
    await ch.handleMessage(p, msg("s1", "check this", { doc: { fileId: "f9", page: 2 } }));
    assert.deepEqual(deliver.mock.calls.map((c) => c.arguments), [["s1", "[CaseLeaf:doc file=f9 page=2] check this"]]);
    assert.deepEqual(c.sent.at(-1), { v: 1, type: "ack", id: "m1" });
  });
  it("unknown session errors", async () => {
    const { ch, deliver } = mk();
    const { c, p } = pane(ch);
    await ch.handleMessage(p, msg("zzz"));
    assert.equal(deliver.mock.calls.length, 0);
    match(c.sent.at(-1), { code: "session_not_found" });
  });
  it("routes replies only to the pane that spoke; drops otherwise; expires", async () => {
    let t = 1000;
    const { ch } = mk({ now: () => t });
    const A = pane(ch), B = pane(ch, conn(), { ...hello, paneId: "p2" });
    assert.equal(ch.reply("s1", "nobody"), 0);
    await ch.handleMessage(A.p, msg("s1"));
    assert.equal(ch.reply("s1", "yo"), 1);
    match(A.c.sent.at(-1), { type: "reply", session: "s1", text: "yo" });
    assert.equal(B.c.sent.filter((f) => f.type === "reply").length, 0);
    assert.equal(ch.reply("s2", "other"), 0);
    t += 31 * 60_000;
    assert.equal(ch.reply("s1", "late"), 0);
    await ch.handleMessage(A.p, msg("s1")); ch.unregister(A.p);
    assert.equal(ch.reply("s1", "gone"), 0);
  });
  it("action confirm / deny / timeout / wrong pane", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      const { ch } = mk({ actionTtlMs: 1000 });
      const A = pane(ch), B = pane(ch, conn(), { ...hello, paneId: "p2" });
      await ch.handleMessage(A.p, msg("s1"));
      const act = (c: ReturnType<typeof conn>) => c.sent.filter((f) => f.type === "action").at(-1) as any;
      const r1 = ch.requestAction("s1", { kind: "mark", args: { page: 1 } });
      const a1 = act(A.c);
      match(a1, { needsConfirm: true, action: { kind: "mark" } });
      assert.equal(act(B.c), undefined);
      assert.equal(ch.handleConfirm(B.p, { actionId: a1.actionId, approve: true }), false);
      match(B.c.sent.at(-1), { code: "unknown_action" });
      assert.equal(ch.handleConfirm(A.p, { actionId: a1.actionId, approve: true }), true);
      assert.deepEqual(await r1, { approved: true });
      const r2 = ch.requestAction("s1", { kind: "revise", args: {} });
      ch.handleConfirm(A.p, { actionId: act(A.c).actionId, approve: false });
      assert.deepEqual(await r2, { approved: false });
      const r3 = ch.requestAction("s1", { kind: "reply", args: {} });
      mock.timers.tick(1500);
      assert.deepEqual(await r3, { timeout: true });
    } finally { mock.timers.reset(); }
  });
  it("rate limits", async () => {
    const { ch, deliver } = mk({ rateLimit: 2 });
    const { c, p } = pane(ch);
    await ch.handleMessage(p, msg()); await ch.handleMessage(p, msg()); await ch.handleMessage(p, msg());
    assert.equal(deliver.mock.calls.length, 2);
    match(c.sent.at(-1), { code: "rate_limited" });
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
    await waitFor(() => assert.deepEqual(deliver.mock.calls.map((c) => c.arguments), [["s1", '[CaseLeaf:doc file=f1 page=1] "sel" hello']]));
    assert.equal(ch.reply("s1", "answer"), 1);
    match(await reply, { session: "s1", text: "answer" });
    const res = ch.requestAction("s1", { kind: "mark", args: { page: 1 } });
    const a = await action;
    client.confirm(a.actionId, true);
    assert.deepEqual(await res, { approved: true });
  });

  it("rejects bad token", async () => {
    const { url } = await up();
    client = new AppChannelClient();
    await assert.rejects(client.connect({ url, app: "CaseLeaf", paneId: "p", token: "bad" }), /auth/);
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
    match(await got, { code: "hello_required" });
  });
});

describe("misc", () => {
  it("parses tokens env", () => { assert.deepEqual(parseTokens("a=1, b=2,bad,=x"), { a: ["1"], b: ["2"] }); });
  it("ingress types appchannel", () => { assert.equal(deliveryFor("appchannel"), "type"); });
});

describe("appchannel bind default", () => {
  afterEach(async () => { (await import("../src/adapters/appchannel/server.js")).stopAppChannelServer(); });
  it("binds 127.0.0.1 unless APPCHANNEL_BIND is set; refuses without tokens", async () => {
    const m = await import("../src/adapters/appchannel/server.js");
    assert.equal(m.startAppChannelServer({ deliver: () => undefined }, { APPCHANNEL_PORT: "0", APPCHANNEL_TOKENS: "CaseLeaf=secret" }), false);
    assert.equal(m.startAppChannelServer({ deliver: () => undefined }, { APPCHANNEL_PORT: "47999", APPCHANNEL_BIND: "0.0.0.0" }), false);
    assert.equal(m.startAppChannelServer({ deliver: () => undefined }, { APPCHANNEL_PORT: "47999", APPCHANNEL_TOKENS: "CaseLeaf=secret" }), true);
    assert.equal(m.getAppChannelBind(), "127.0.0.1");
  });
});
