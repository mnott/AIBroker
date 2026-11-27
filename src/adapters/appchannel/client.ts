/**
 * adapters/appchannel/client.ts — minimal reference client for app authors (Node).
 * connect() resolves once the hub answered hello with `ready`, rejects on `error`.
 */
import WebSocket from "ws";
import type { ActionSpec, HubFrame, MessageContext } from "./protocol.js";

export interface ConnectOpts { url: string; app: string; paneId: string; token: string }
export type ReplyHandler = (r: { session: string; text: string; inReplyTo?: string }) => void;
export type ActionHandler = (a: { actionId: string; session: string; action: ActionSpec }) => void;

export class AppChannelClient {
  private ws: WebSocket | null = null;
  private replyCb: ReplyHandler[] = [];
  private actionCb: ActionHandler[] = [];
  private errorCb: Array<(code: string, message: string) => void> = [];
  private seq = 0;

  connect(o: ConnectOpts): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = (this.ws = new WebSocket(o.url));
      ws.on("open", () => ws.send(JSON.stringify({ v: 1, type: "hello", app: o.app, paneId: o.paneId, token: o.token })));
      ws.on("error", reject);
      ws.on("close", () => reject(new Error("closed before ready")));
      ws.on("message", (d) => {
        let f: HubFrame;
        try { f = JSON.parse(d.toString()) as HubFrame; } catch { return; }
        if (f.type === "ready") resolve();
        else if (f.type === "error") { reject(new Error(`${f.code}: ${f.message}`)); this.errorCb.forEach((c) => c(f.code, f.message)); }
        else if (f.type === "reply") this.replyCb.forEach((c) => c(f));
        else if (f.type === "action") this.actionCb.forEach((c) => c(f));
      });
    });
  }

  /** Returns the generated message id (acked by the hub with `ack`). */
  send(session: string, text: string, context?: MessageContext): string {
    const id = `m${Date.now().toString(36)}${++this.seq}`;
    this.ws?.send(JSON.stringify({ v: 1, type: "message", id, session, text, ...(context && { context }) }));
    return id;
  }
  onReply(cb: ReplyHandler): void { this.replyCb.push(cb); }
  onAction(cb: ActionHandler): void { this.actionCb.push(cb); }
  onError(cb: (code: string, message: string) => void): void { this.errorCb.push(cb); }
  /** Answer an `action`; apply it in the app only when approve is true. */
  confirm(actionId: string, approve: boolean): void { this.ws?.send(JSON.stringify({ v: 1, type: "confirm", actionId, approve })); }
  close(): void { this.ws?.close(); this.ws = null; }
}
