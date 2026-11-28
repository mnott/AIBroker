/**
 * adapters/appchannel/server.ts — WebSocket endpoint for app panes.
 * Env: APPCHANNEL_PORT (default 0 = disabled), APPCHANNEL_BIND (default 0.0.0.0; use the
 * Tailscale/LAN address), APPCHANNEL_TOKENS ("app=token,app2=token2"). Tokens are never logged.
 */
import { WebSocketServer, type WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import { log } from "../../core/log.js";
import { AppChannel, type AppChannelDeps, type Pane } from "./channel.js";
import { MAX_FRAME_BYTES, parseClientFrame, type HubFrame } from "./protocol.js";

export const APPCHANNEL_PATH = "/appchannel";

export function parseTokens(s: string | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of (s ?? "").split(",")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const app = part.slice(0, i).trim(), tok = part.slice(i + 1).trim();
    if (app && tok) (out[app] ??= []).push(tok);
  }
  return out;
}

/** Attach the protocol to a ws server. Exported for tests. */
export function attachAppChannel(wss: WebSocketServer, channel: AppChannel, helloTimeoutMs = 5000): void {
  wss.on("connection", (ws: WebSocket) => {
    let pane: Pane | null = null;
    const send = (f: HubFrame) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(f)); };
    const timer = setTimeout(() => { if (!pane) { send({ v: 1, type: "error", code: "hello_timeout", message: "hello required" }); ws.close(); } }, helloTimeoutMs);
    ws.on("message", (data) => {
      const raw = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
      const r = parseClientFrame(raw);
      if (!r.ok) { send({ v: 1, type: "error", code: "bad_frame", message: r.error }); if (!pane) ws.close(); return; }
      const f = r.frame;
      if (!pane) {
        if (f.type !== "hello") { send({ v: 1, type: "error", code: "hello_required", message: "first frame must be hello" }); ws.close(); return; }
        pane = channel.registerPane({ send }, f);
        clearTimeout(timer);
        if (!pane) ws.close();
        return;
      }
      if (f.type === "ping") send({ v: 1, type: "pong" });
      else if (f.type === "message") void channel.handleMessage(pane, f);
      else if (f.type === "confirm") channel.handleConfirm(pane, f);
      else send({ v: 1, type: "error", code: "bad_frame", message: "unexpected hello" });
    });
    ws.on("close", () => { clearTimeout(timer); if (pane) channel.unregister(pane); });
    ws.on("error", () => { /* close follows */ });
  });
}

// --- module singleton ---
let channel: AppChannel | null = null;
let wss: WebSocketServer | null = null;
let activePort = 0;

/** The singleton channel (an empty one until the server is started). */
export const appChannel: AppChannel = new AppChannel({ deliver: () => undefined }, { tokens: {} });
let current: AppChannel = appChannel;
export function getAppChannel(): AppChannel { return current; }
export function getAppChannelPort(): number { return activePort; }

let activeBind = "";
export function getAppChannelBind(): string { return activeBind; }

const isLoopback = (h: string): boolean => h === "localhost" || h === "::1" || /^127\./.test(h);

export function startAppChannelServer(deps: AppChannelDeps, env: NodeJS.ProcessEnv = process.env): boolean {
  const port = Number(env.APPCHANNEL_PORT ?? 0);
  if (!Number.isInteger(port) || port <= 0) { log("[AppChannel] APPCHANNEL_PORT not set — app channel disabled"); return false; }
  const tokens = parseTokens(env.APPCHANNEL_TOKENS);
  if (!Object.keys(tokens).length) { log("[AppChannel] APPCHANNEL_TOKENS empty — app channel disabled"); return false; }
  if (wss) return true;
  // Loopback unless explicitly configured; exposure is only ever opt-in, and tokens are already required above.
  const bind = env.APPCHANNEL_BIND || "127.0.0.1";
  if (!isLoopback(bind)) log(`[AppChannel] WARNING: bound to non-loopback ${bind} (APPCHANNEL_BIND), token auth required`);
  activeBind = bind;
  channel = new AppChannel(deps, { tokens });
  current = channel;
  const s = new WebSocketServer({ port, host: bind, path: APPCHANNEL_PATH, maxPayload: MAX_FRAME_BYTES });
  attachAppChannel(s, channel);
  s.on("error", (e) => { log(`[AppChannel] server error: ${e.message}`); if (wss === s) { wss = null; activePort = 0; } });
  s.on("listening", () => { activePort = (s.address() as AddressInfo).port; log(`[AppChannel] listening on ${bind}:${activePort}${APPCHANNEL_PATH} apps=${Object.keys(tokens).join(",")}`); });
  wss = s;
  activePort = port;
  return true;
}

export function stopAppChannelServer(): void {
  channel?.closeAll();
  wss?.close();
  wss = null;
  channel = null;
  current = appChannel;
  activePort = 0;
}
