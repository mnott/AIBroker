/**
 * daemon/todoist-webhook.ts — Todoist as an inbound channel.
 *
 * File a task from a phone or a watch and it reaches the session that owns the
 * project, without a poller. Todoist pushes; the daemon routes it to `dispatch`.
 *
 * ── Why webhooks rather than polling ────────────────────────────────────────
 *
 * Polling forces a choice between latency and cost, and gets both wrong. The
 * decisive detail is that `reminder:fired` is a webhook event: a task with a
 * reminder pushes AT the reminder time. Due dates do NOT push — a task merely
 * becoming due fires nothing — so scheduling is expressed as a reminder, and
 * "run the sweep at 09:00" needs no timer anywhere in this system.
 *
 * ── This is an execution ingress, so it is deliberately narrow ──────────────
 *
 * A task arriving here becomes an instruction a session acts on with the
 * user's full rights. Todoist's own payload documents that `initiator` "may be
 * the same user indicated in user_id OR A COLLABORATOR FROM A SHARED PROJECT",
 * which is precisely the exposure: without a boundary, anyone on any shared
 * project has a path to this machine. Hence:
 *
 *   - Only tasks under a configured ingress project (or its children) are
 *     considered. Everything else is acknowledged and dropped.
 *   - Every request must carry a valid HMAC signature.
 *   - Everything — accepted, ignored, refused — goes through the audit trail.
 *
 * ── Echo loops ──────────────────────────────────────────────────────────────
 *
 * `note:added` is an event, so an agent commenting on a task triggers a webhook
 * that could route back to an agent that comments again. `initiator` cannot
 * break the cycle: when agents act as the user, the initiator IS the user. Our
 * own writes are therefore marked, and marked content is ignored on the way in.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { log } from "../core/log.js";
import { audit } from "./audit.js";

/** Prefix on anything an agent writes back to Todoist, so we ignore our own echo. */
export const AGENT_MARK = "🤖";

export interface TodoistEvent {
  event_name: string;
  user_id?: string;
  event_data?: Record<string, unknown>;
  event_data_extra?: Record<string, unknown>;
  initiator?: { email?: string; full_name?: string; id?: string };
  triggered_at?: string;
  version?: string;
}

export interface WebhookConfig {
  /** Client secret from the App Management Console — signs every request. */
  secret: string;
  port: number;
  /**
   * Interface to bind. Loopback by default.
   *
   * Todoist calls from the public internet, so SOMETHING must expose this —
   * but that something should terminate TLS and forward to loopback, not have
   * this process on a public interface. Tailscale Funnel, Cloudflare Tunnel and
   * a Caddy/nginx reverse proxy all work that way. Note Funnel specifically,
   * not Serve: Serve is reachable only from inside the tailnet, and Todoist's
   * servers are not in it.
   */
  bind: string;
  /** Path the receiver answers on. Anything else 404s. */
  path: string;
  /**
   * Project ids allowed to reach a session. An explicit allowlist, not a
   * subtree resolved at runtime, and deliberately so: a project added later
   * does not silently become an execution ingress. It has to be granted.
   */
  ingressProjectIds: Set<string>;
  /** project id -> session that owns it, for tasks filed straight into a project. */
  projectOwners: Map<string, string>;
  /**
   * Where a task with no owner goes — the watch case, where everything lands
   * in the Inbox with no project and no label. Unset means such tasks are
   * recorded and dropped rather than guessed at.
   */
  defaultOwner?: string;
}

export type RouteDecision =
  | { act: true; project: string; body: string; taskId: string }
  | { act: false; reason: string };

/**
 * Verify Todoist's HMAC over the RAW body.
 *
 * Must run against the exact bytes received: re-serialising parsed JSON changes
 * key order and whitespace and the signature will never match.
 */
export function verifySignature(raw: Buffer, header: string | undefined, secret: string): boolean {
  if (!header || !secret) return false;
  const expected = createHmac("sha256", secret).update(raw).digest();
  let got: Buffer;
  try { got = Buffer.from(header, "base64"); } catch { return false; }
  if (got.length !== expected.length) return false;
  return timingSafeEqual(got, expected);
}

/** Stable identity for an event, for replay/duplicate suppression. */
export function eventKey(e: TodoistEvent): string {
  const id = (e.event_data?.id as string) ?? "?";
  return `${e.event_name}:${id}:${e.triggered_at ?? ""}`;
}

/**
 * Decide whether an event should reach a session, and as what.
 *
 * Pure, so the routing rules are testable without a socket: this function is
 * the entire security boundary of the ingress.
 */
export function route(e: TodoistEvent, cfg: WebhookConfig): RouteDecision {
  const data = e.event_data ?? {};
  const content = typeof data.content === "string" ? data.content : "";
  const description = typeof data.description === "string" ? data.description : "";
  const taskId = typeof data.id === "string" ? data.id : String(data.id ?? "");

  // Our own writes come back as events. Drop them before anything else, or an
  // agent's comment becomes an instruction to an agent.
  if (content.startsWith(AGENT_MARK) || description.startsWith(AGENT_MARK)) {
    return { act: false, reason: "agent-authored content, ignored to avoid an echo loop" };
  }

  const ACTIONABLE = new Set(["item:added", "item:completed", "reminder:fired"]);
  if (!ACTIONABLE.has(e.event_name)) {
    return { act: false, reason: `event ${e.event_name} is not actionable` };
  }
  // Completion is the human saying "done"; it must never start work.
  if (e.event_name === "item:completed") {
    return { act: false, reason: "task completed — recorded, no action taken" };
  }

  const projectId = typeof data.project_id === "string" ? data.project_id : "";
  if (!cfg.ingressProjectIds.has(projectId)) {
    // The boundary. Anything outside the allowlist is acknowledged and dropped,
    // so a task filed into a shared project cannot reach a session.
    return { act: false, reason: `project ${projectId || "?"} is not an ingress project` };
  }

  if (!content.trim()) {
    return { act: false, reason: "task has no content" };
  }

  // Owner, most explicit first:
  //   1. a `pai:<name>` label      — say exactly where it goes
  //   2. the project it was filed in — "put it in the Whazaa list"
  //   3. the configured default     — the watch case: Inbox, no label, no project
  const labels = Array.isArray(data.labels) ? (data.labels as unknown[]).map(String) : [];
  const labelled = labels.map((l) => l.trim())
    .find((l) => l.toLowerCase().startsWith("pai:"))?.slice(4).trim();
  const owner = labelled || cfg.projectOwners.get(projectId) || cfg.defaultOwner;

  if (!owner) {
    return {
      act: false,
      reason: "no pai:<name> label, no owner for this project, and no default owner configured",
    };
  }

  const body = description.trim() ? `${content}\n\n${description}` : content;
  return { act: true, project: owner, body, taskId };
}

/** Bounded replay guard: Todoist retries, and a retry must not run work twice. */
class SeenSet {
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];
  constructor(private readonly max = 2_000) {}
  has(k: string): boolean { return this.seen.has(k); }
  add(k: string): void {
    if (this.seen.has(k)) return;
    this.seen.add(k);
    this.order.push(k);
    if (this.order.length > this.max) {
      const drop = this.order.shift();
      if (drop) this.seen.delete(drop);
    }
  }
}

export interface WebhookDeps {
  /** Deliver a work order. Returns a short outcome for the audit record. */
  deliver: (project: string, body: string) => Promise<{ outcome: string; session: string; reason?: string }>;
}

function readBody(req: IncomingMessage, limit = 1_000_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new Error("payload too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function createWebhookServer(cfg: WebhookConfig, deps: WebhookDeps): Server {
  const seen = new SeenSet();

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      if (req.method !== "POST") { res.writeHead(405).end(); return; }
      // Ignore query strings; a proxy may append them.
      const reqPath = (req.url ?? "/").split("?")[0];
      if (reqPath !== cfg.path) { res.writeHead(404).end(); return; }

      let raw: Buffer;
      try {
        raw = await readBody(req);
      } catch {
        res.writeHead(413).end();
        return;
      }

      if (!verifySignature(raw, req.headers["x-todoist-hmac-sha256"] as string | undefined, cfg.secret)) {
        // Unsigned or wrongly signed: someone found the endpoint. Worth a record.
        audit({
          action: "webhook", actor: "todoist:unsigned", target: "aibroker",
          outcome: "rejected", reason: "invalid or missing HMAC signature",
        });
        log("todoist-webhook: rejected a request with an invalid signature");
        res.writeHead(401).end();
        return;
      }

      let event: TodoistEvent;
      try {
        event = JSON.parse(raw.toString("utf-8")) as TodoistEvent;
      } catch {
        res.writeHead(400).end();
        return;
      }

      // Acknowledge immediately, then work. Todoist retries on a slow or failed
      // response, and a dispatch can take a minute — without this, every slow
      // delivery is retried and the work runs more than once.
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');

      const key = eventKey(event);
      if (seen.has(key)) {
        log(`todoist-webhook: duplicate ${key}, ignored`);
        return;
      }
      seen.add(key);

      const decision = route(event, cfg);
      const who = event.initiator?.email ?? event.initiator?.full_name ?? "todoist";

      if (!decision.act) {
        audit({
          action: "webhook", actor: `todoist:${who}`, target: "aibroker",
          outcome: "ignored", reason: decision.reason,
          meta: { event: event.event_name, task: (event.event_data?.content as string) ?? undefined },
        });
        return;
      }

      try {
        const r = await deps.deliver(decision.project, decision.body);
        audit({
          action: "webhook", actor: `todoist:${who}`, target: r.session || decision.project,
          outcome: r.outcome, body: decision.body, reason: r.reason,
          meta: { event: event.event_name, taskId: decision.taskId },
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        audit({
          action: "webhook", actor: `todoist:${who}`, target: decision.project,
          outcome: "failed", body: decision.body, reason,
          meta: { event: event.event_name, taskId: decision.taskId },
        });
        log(`todoist-webhook: delivery failed — ${reason}`);
      }
    })();
  });
}

/** Read config from the environment. Returns null when not configured. */
export function webhookConfigFromEnv(): WebhookConfig | null {
  const secret = process.env.TODOIST_CLIENT_SECRET;
  if (!secret) return null;
  // "id" or "id=owner", comma-separated. The owner half is optional and maps a
  // project to the session that owns work filed there.
  const ids = new Set<string>();
  const owners = new Map<string, string>();
  for (const entry of (process.env.TODOIST_INGRESS_PROJECTS ?? "").split(",")) {
    const [id, owner] = entry.split("=").map((s) => s.trim());
    if (!id) continue;
    ids.add(id);
    if (owner) owners.set(id, owner);
  }

  return {
    secret,
    port: Number(process.env.TODOIST_WEBHOOK_PORT) || 8766,
    bind: process.env.TODOIST_WEBHOOK_BIND ?? "127.0.0.1",
    path: process.env.TODOIST_WEBHOOK_PATH ?? "/todoist",
    ingressProjectIds: ids,
    projectOwners: owners,
    defaultOwner: process.env.TODOIST_DEFAULT_OWNER,
  };
}

/** Start the receiver if configured. No-op otherwise. */
export function startTodoistWebhook(deps: WebhookDeps): Server | null {
  const cfg = webhookConfigFromEnv();
  if (!cfg) {
    log("todoist-webhook: not configured (set TODOIST_CLIENT_SECRET to enable)");
    return null;
  }
  if (cfg.ingressProjectIds.size === 0) {
    // Refusing here is deliberate: with an empty allowlist the ingress would
    // accept work from every project on the account, including shared ones.
    log("todoist-webhook: TODOIST_INGRESS_PROJECTS is empty — refusing to accept every project");
    return null;
  }

  const server = createWebhookServer(cfg, deps);
  if (cfg.bind !== "127.0.0.1" && cfg.bind !== "localhost") {
    log(`todoist-webhook: WARNING binding ${cfg.bind}, not loopback — this puts an execution ingress ` +
        `directly on the network. Prefer loopback with a TLS proxy (Tailscale Funnel, Cloudflare Tunnel, Caddy) in front.`);
  }
  server.listen(cfg.port, cfg.bind, () => {
    log(`todoist-webhook: listening on ${cfg.bind}:${cfg.port}${cfg.path}, ` +
        `${cfg.ingressProjectIds.size} ingress project(s), default owner ${cfg.defaultOwner ?? "(none)"}`);
  });
  server.on("error", (err) => log(`todoist-webhook: server error — ${err.message}`));
  return server;
}
