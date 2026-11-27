/**
 * adapters/appchannel/channel.ts — hub-side routing for app panes.
 * Document actions are never applied here: the app applies them after the user approves.
 */
import { randomUUID } from "node:crypto";
import { macEquals } from "../pailot/ble-crypto.js";
import { formatInbound, type ActionSpec, type ClientFrame, type HubFrame } from "./protocol.js";

export interface PaneConn { send(frame: HubFrame): void }
type Hello = Extract<ClientFrame, { type: "hello" }>;
type Msg = Extract<ClientFrame, { type: "message" }>;

export interface Pane { conn: PaneConn; app: string; paneId: string; stamps: number[] }
export interface AppChannelDeps {
  deliver(sessionId: string, text: string): Promise<void> | void;
  sessionExists?(id: string): boolean;
  now?: () => number;
}
export interface AppChannelOpts {
  /** app -> accepted token(s) */
  tokens: Record<string, string | string[]>;
  replyWindowMs?: number;
  actionTtlMs?: number;
  rateLimit?: number;
}
export type ActionResult = { approved: boolean } | { timeout: true };

const err = (code: string, message: string): HubFrame => ({ v: 1, type: "error", code, message });

export class AppChannel {
  private tokens: Map<string, string[]>;
  private lastSpoke = new Map<string, Map<Pane, number>>(); // session -> pane -> time
  private pending = new Map<string, { panes: Set<Pane>; resolve: (r: ActionResult) => void; timer: ReturnType<typeof setTimeout> }>();
  private panes = new Set<Pane>();
  private now: () => number;
  private replyWindow: number;
  private actionTtl: number;
  private rateLimit: number;

  constructor(private deps: AppChannelDeps, opts: AppChannelOpts) {
    this.tokens = new Map(Object.entries(opts.tokens).map(([a, t]) => [a, Array.isArray(t) ? t : [t]]));
    this.now = deps.now ?? Date.now;
    this.replyWindow = opts.replyWindowMs ?? 30 * 60_000;
    this.actionTtl = opts.actionTtlMs ?? 10 * 60_000;
    this.rateLimit = opts.rateLimit ?? 30;
  }

  get hasTokens(): boolean { return this.tokens.size > 0; }

  /** Returns the pane, or null after sending an `auth` error. */
  registerPane(conn: PaneConn, hello: Hello): Pane | null {
    const toks = this.tokens.get(hello.app);
    let ok = false;
    // Compare against every token (no early exit) to keep timing flat.
    for (const t of toks ?? []) if (macEquals(hello.token, t)) ok = true;
    if (!toks || !ok) { conn.send(err("auth", "authentication failed")); return null; }
    const pane: Pane = { conn, app: hello.app, paneId: hello.paneId, stamps: [] };
    this.panes.add(pane);
    conn.send({ v: 1, type: "ready" });
    return pane;
  }

  unregister(pane: Pane): void {
    this.panes.delete(pane);
    for (const m of this.lastSpoke.values()) m.delete(pane);
    for (const [id, p] of this.pending) {
      p.panes.delete(pane);
      if (p.panes.size === 0) { clearTimeout(p.timer); this.pending.delete(id); p.resolve({ timeout: true }); }
    }
  }

  async handleMessage(pane: Pane, f: Msg): Promise<boolean> {
    const t = this.now();
    pane.stamps = pane.stamps.filter((s) => t - s < 60_000);
    if (pane.stamps.length >= this.rateLimit) { pane.conn.send(err("rate_limited", "too many messages")); return false; }
    pane.stamps.push(t);
    if (this.deps.sessionExists && !this.deps.sessionExists(f.session)) {
      pane.conn.send(err("session_not_found", "no such session")); return false;
    }
    try { await this.deps.deliver(f.session, formatInbound(pane.app, f.text, f.context)); }
    catch (e) { pane.conn.send(err("deliver_failed", e instanceof Error ? e.message : "delivery failed")); return false; }
    let m = this.lastSpoke.get(f.session);
    if (!m) this.lastSpoke.set(f.session, (m = new Map()));
    m.set(pane, t);
    pane.conn.send({ v: 1, type: "ack", id: f.id });
    return true;
  }

  private targets(sessionId: string): Pane[] {
    const m = this.lastSpoke.get(sessionId);
    if (!m) return [];
    const t = this.now();
    const out: Pane[] = [];
    for (const [p, at] of m) {
      if (t - at > this.replyWindow || !this.panes.has(p)) m.delete(p); else out.push(p);
    }
    return out;
  }

  /** Number of panes reached (0 = dropped). */
  reply(sessionId: string, text: string, inReplyTo?: string): number {
    let n = 0;
    for (const p of this.targets(sessionId)) {
      try { p.conn.send({ v: 1, type: "reply", session: sessionId, text, ...(inReplyTo && { inReplyTo }) }); n++; } catch { /* dead conn */ }
    }
    return n;
  }

  requestAction(sessionId: string, action: ActionSpec): Promise<ActionResult> {
    const panes = this.targets(sessionId);
    if (!panes.length) return Promise.resolve({ timeout: true });
    const actionId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(actionId); resolve({ timeout: true }); }, this.actionTtl);
      this.pending.set(actionId, { panes: new Set(panes), resolve, timer });
      for (const p of panes) {
        try { p.conn.send({ v: 1, type: "action", actionId, session: sessionId, action, needsConfirm: true }); } catch { /* ignore */ }
      }
    });
  }

  handleConfirm(pane: Pane, f: { actionId: string; approve: boolean }): boolean {
    const p = this.pending.get(f.actionId);
    if (!p || !p.panes.has(pane)) { pane.conn.send(err("unknown_action", "no such pending action")); return false; }
    clearTimeout(p.timer);
    this.pending.delete(f.actionId);
    p.resolve({ approved: f.approve });
    return true;
  }

  closeAll(): void {
    for (const p of [...this.panes]) this.unregister(p);
  }
}
