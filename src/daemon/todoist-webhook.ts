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
import { handleOAuthCallback } from "./todoist-oauth.js";

/** Prefix on anything an agent writes back to Todoist, so we ignore our own echo. */
export const AGENT_MARK = "🤖";

/**
 * Label a runner puts on a task it has claimed.
 *
 * PAI's poller sets it before doing anything else, so a crash leaves the task
 * visibly in flight rather than silently dispatched twice. The webhook path
 * honours the same label: two mechanisms watching the same checkbox must not
 * both fire for one tick.
 */
export const RUNNING_LABEL = "pai-running";

/**
 * Is this task a click-to-run trigger rather than a piece of work?
 *
 * Two conditions, and both matter. It RECURS, so ticking it reschedules rather
 * than ends it — that is what makes a checkbox usable as a button. And it
 * carries an explicit routing label, so it was built to be dispatched: without
 * that, a recurring shopping list in an allowed project becomes a work order
 * the first time someone ticks it.
 */
export function isTrigger(data: Record<string, unknown>): boolean {
  const labels = Array.isArray(data.labels) ? (data.labels as unknown[]).map(String) : [];
  const due = data.due as { is_recurring?: boolean } | undefined;
  return Boolean(due?.is_recurring) && labels.some((l) => l.toLowerCase().startsWith("pai:"));
}

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
   * Client id from the App Management Console.
   *
   * Only needed for the OAuth landing below — the webhook path itself is
   * verified by HMAC and never uses it.
   */
  clientId?: string;
  /**
   * Path the OAuth redirect lands on.
   *
   * Todoist rejects a redirect URL carrying a port, so this one cannot be
   * reached over the same Funnel as the webhook. Put a tailnet-only Serve on
   * 443 in front of it — see docs/todoist.md.
   */
  oauthPath: string;
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

/** Which rule chose the owner. Recorded, so a wrong guess is visible. */
export type OwnerRule = "label" | "address" | "held" | "project" | "default";

export type RouteDecision =
  | { act: true; project: string; body: string; taskId: string; rule: OwnerRule; nearMiss?: string }
  | { act: false; reason: string; nearMiss?: string };

/**
 * Something that looked like an address but was not one.
 *
 * A task saying `PAI do the thing` or labelled `pai` reads, to a human, as an
 * instruction about where it should go. Neither parses, and the silent outcome
 * is that it lands on the default owner as though nothing had been asked for.
 * That is the failure this project keeps having to fix: a suppression nobody
 * counts is indistinguishable from an event that never happened. So we say it.
 */
function detectNearMiss(labels: string[], firstToken: string | null, addressed: boolean, known: Set<string>): string | undefined {
  const labelAttempt = labels.find((l) => {
    const low = l.toLowerCase();
    // A label that already routes is not a near miss, whichever form it took.
    if (low.startsWith("pai:") || known.has(low)) return false;
    return low.startsWith("pai");
  });
  if (labelAttempt) return `label "${labelAttempt}" names nobody — use a session name, or pai:<name>`;
  if (addressed && firstToken && !known.has(firstToken.toLowerCase())) {
    return `"${firstToken}" reads as an address but no session by that name is known`;
  }
  return undefined;
}

/**
 * Owner named by a label, in either accepted form.
 *
 * `pai:<name>` is explicit and works even for a name we have never heard of.
 * A bare `<name>` label is the cheap form — one tap in Todoist's picker — and
 * is accepted only when it matches something dispatch can actually resolve,
 * so an ordinary label like `urgent` stays an ordinary label.
 */
function ownerFromLabels(labels: string[], known: Set<string>): string | undefined {
  for (const raw of labels.map((l) => l.trim())) {
    const low = raw.toLowerCase();
    if (low.startsWith("pai:")) {
      const name = raw.slice(4).trim();
      if (name) return name;
    }
    if (known.has(low)) return low;
  }
  return undefined;
}

/**
 * Pull a leading session name off the content.
 *
 * Typing a label is several taps on a phone and worse on a watch, so the
 * cheapest possible address is the first word: "pai send a whatsapp message".
 * Only names we already know are accepted — otherwise "home improvements"
 * becomes a work order for the Home session — and an explicit `name:` or
 * `name,` counts as addressing even when the name is unknown, so that a typo
 * can be reported instead of silently ignored.
 */
export function parseAddress(
  content: string,
  known: Set<string>,
): { owner?: string; rest: string; firstToken: string | null; addressed: boolean } {
  const m = /^([\p{L}\p{N}_-]+)([:,])?\s+([\s\S]+)$/u.exec(content.trim());
  if (!m) return { rest: content, firstToken: null, addressed: false };
  const [, token, punct, rest] = m;
  const addressed = Boolean(punct);
  if (known.has(token.toLowerCase())) return { owner: token.toLowerCase(), rest, firstToken: token, addressed: true };
  return { rest: content, firstToken: token, addressed };
}

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
export function route(
  e: TodoistEvent,
  cfg: WebhookConfig,
  knownOwners: Iterable<string> = [],
  /**
   * The session already holding this task, when we know it.
   *
   * Only meaningful for a comment: a follow-up belongs to whoever did the work,
   * not to whatever the project mapping would pick today.
   */
  heldBy?: string,
): RouteDecision {
  // Names we will accept as an address: every session the hub can see, plus
  // every owner named in config. Config counts even when the session is not
  // running, so "clickr do x" is understood and reported as undeliverable
  // rather than being read as the first word of a shopping list.
  const known = new Set<string>();
  for (const n of knownOwners) if (n) known.add(n.toLowerCase());
  for (const o of cfg.projectOwners.values()) known.add(o.toLowerCase());
  if (cfg.defaultOwner) known.add(cfg.defaultOwner.toLowerCase());

  const data = e.event_data ?? {};
  const content = typeof data.content === "string" ? data.content : "";
  const description = typeof data.description === "string" ? data.description : "";
  const taskId = typeof data.id === "string" ? data.id : String(data.id ?? "");

  // Our own writes come back as events. Drop the ECHO — the event that fires
  // the instant we write — or an agent's own note becomes an instruction to
  // itself, which is how a session probing due-date parsing handed itself a
  // dozen tasks in four minutes.
  //
  // Deliberately NOT applied to reminder:fired. Filing work for yourself to do
  // later is the point of this channel: a click-to-run task with a schedule,
  // "run the sweep at 08:00", a reminder set now for next week. Those are
  // agent-authored on purpose and must fire when their time comes. What must
  // not happen is the write bouncing straight back.
  const isEcho = e.event_name === "item:added" || e.event_name === "note:added";
  if (isEcho && (content.startsWith(AGENT_MARK) || description.startsWith(AGENT_MARK))) {
    return { act: false, reason: "agent-authored content, ignored to avoid an echo loop" };
  }

  const ACTIONABLE = new Set(["item:added", "item:completed", "reminder:fired", "note:added"]);
  if (!ACTIONABLE.has(e.event_name)) {
    return { act: false, reason: `event ${e.event_name} is not actionable` };
  }

  // Creating a recurring, addressed task DEFINES a trigger; it does not pull
  // it. Adding a crontab line does not run the job. Without this, filing a
  // click-to-run task fires it once on creation and then again on the first
  // tick — one intent, two runs, half a second apart.
  if (e.event_name === "item:added" && isTrigger(data)) {
    return { act: false, reason: "recurring trigger defined — it will run when fired or ticked, not now" };
  }
  // Completion is the human saying "done"; it must never start work.
  //
  // Except for one shape, which is not an ending at all. Ticking a RECURRING
  // task does not close it — Todoist advances the due date and the task stays
  // open. That is the click-to-run pattern: a checkbox used as a Run Now
  // button, which is how "run the sweep" is meant to be triggered by hand.
  //
  // Three conditions, all required, because getting this wrong means ticking
  // something off starts work you thought you were finishing:
  //   - the task recurs, so completing it is a reschedule, not a close
  //   - it carries an explicit routing label, so it was built to be dispatched
  //   - it is not already in flight (`pai-running`), so a poller that has
  //     already claimed this tick is not raced by the webhook
  if (e.event_name === "item:completed") {
    const labels = Array.isArray(data.labels) ? (data.labels as unknown[]).map(String) : [];
    if (labels.some((l) => l.toLowerCase() === RUNNING_LABEL)) {
      return { act: false, reason: `task is already in flight (${RUNNING_LABEL}) — completion ignored` };
    }
    if (!isTrigger(data)) {
      return { act: false, reason: "task completed — recorded, no action taken" };
    }
    // Falls through to normal routing: a trigger goes wherever its label says.
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
  //   1. a `pai:<name>` label       — say exactly where it goes
  //   2. a leading name in the text — "pai send a whatsapp message"
  //   3. the session already holding it — a comment follows its work
  //   4. the project it was filed in — "put it in the Whazaa list"
  //   5. the configured default      — the watch case: Inbox, no label, no text address
  //
  // Text beats project: what you wrote is more deliberate than where it landed,
  // and on a watch the project is whatever the quick-capture button chose.
  const labels = Array.isArray(data.labels) ? (data.labels as unknown[]).map(String) : [];
  const labelled = ownerFromLabels(labels, known);

  const addr = parseAddress(content, known);
  const nearMiss = detectNearMiss(labels, addr.firstToken, addr.addressed, known);

  let owner: string | undefined;
  let rule: OwnerRule;
  if (labelled) { owner = labelled; rule = "label"; }
  else if (addr.owner) { owner = addr.owner; rule = "address"; }
  else if (heldBy) { owner = heldBy; rule = "held"; }
  else if (cfg.projectOwners.get(projectId)) { owner = cfg.projectOwners.get(projectId); rule = "project"; }
  else { owner = cfg.defaultOwner; rule = "default"; }

  if (!owner) {
    return {
      act: false,
      reason: "no pai:<name> label, no name in the text, no owner for this project, and no default owner configured",
      nearMiss,
    };
  }

  // Only the address rule consumed part of the title; every other rule leaves
  // the text exactly as written.
  const title = rule === "address" ? addr.rest : content;
  const body = description.trim() ? `${title}\n\n${description}` : title;
  return { act: true, project: owner, body, taskId, rule, nearMiss };
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
  /**
   * Deliver a work order. Returns a short outcome for the audit record.
   *
   * `prefix` distinguishes a correction from a new work order: `[Task]` reads
   * as "start this", and a session that receives a comment under that heading
   * will begin again rather than adjust.
   */
  deliver: (project: string, body: string, opts?: { prefix?: string }) =>
    Promise<{ outcome: string; session: string; reason?: string }>;
  /**
   * Names that may be used as an address in a task's first word.
   *
   * Must be the names DISPATCH can resolve, not merely the ones a human would
   * recognise. Addressing a live session that dispatch has no alias for reads
   * as success and delivers nothing — which is exactly how "paicloud send me a
   * mail" was quietly answered by the wrong session.
   *
   * A function rather than a list: aliases and sessions both change while the
   * daemon runs, and a name that was valid at boot need not be valid now.
   */
  knownOwners?: () => string[] | Promise<string[]>;
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
      // Ignore query strings on the webhook path; a proxy may append them. The
      // OAuth landing is the one place here where the query IS the payload.
      const reqPath = (req.url ?? "/").split("?")[0];

      if (req.method === "GET" && reqPath === cfg.oauthPath) {
        const url = new URL(req.url ?? "/", "http://localhost");
        const { status, html } = await handleOAuthCallback(url, {
          clientId: cfg.clientId,
          clientSecret: cfg.secret,
        });
        res.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(html);
        return;
      }

      if (req.method !== "POST") { res.writeHead(405).end(); return; }
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

      // Deleting the project revokes its ingress. A grant outliving the thing
      // it points at is dead weight in a security boundary: it reads as though
      // access is still open, and if the id is ever reused it silently is. The
      // boundary should only ever shrink on its own.
      if (event.event_name === "project:deleted") {
        const gone = String(event.event_data?.id ?? "");
        if (gone) {
          const { revokeIngress } = await import("./todoist-ingress.js");
          if (revokeIngress(gone)) {
            log(`todoist-webhook: project ${gone} was deleted — its ingress grant is revoked`);
          }
        }
        // Still not actionable as work; fall through to be recorded as ignored.
      }

      // A comment carries item_id and its own text and nothing else — no
      // project, no labels — so the boundary cannot be evaluated until the
      // parent task is resolved. Do it before routing, and let a failed lookup
      // drop the event rather than route it against a missing project, which
      // the allowlist would refuse anyway but for the wrong reason.
      if (event.event_name === "note:added" && !event.event_data?.project_id) {
        const parentId = String(event.event_data?.item_id ?? "");
        if (!parentId) {
          audit({
            action: "webhook", actor: "todoist", target: "aibroker", outcome: "ignored",
            reason: "comment carries no item_id", meta: { event: event.event_name },
          });
          return;
        }
        try {
          const { fetchParentTask } = await import("./todoist-reply.js");
          const parent = await fetchParentTask(parentId);
          event.event_data = {
            ...event.event_data,
            id: parentId,
            project_id: parent.projectId,
            labels: parent.labels,
            // Answer on the task, about the task: the comment is the
            // instruction, the title is the context it makes sense in.
            description: parent.content ? `(comment on "${parent.content}")` : "",
          };
        } catch (err) {
          const reason = `could not resolve the task a comment belongs to — ${err instanceof Error ? err.message : String(err)}`;
          audit({
            action: "webhook", actor: "todoist", target: "aibroker",
            outcome: "ignored", reason, meta: { event: event.event_name, taskId: parentId },
          });
          log(`todoist-webhook: ${reason}`);
          return;
        }
      }

      const isComment = event.event_name === "note:added";
      const parentId = String(event.event_data?.id ?? "");
      const { ownerOf, rememberOwner } = await import("./todoist-owners.js");
      // Grants made since the daemon started take effect now, not at the next
      // restart. A project created and granted while you are using the system
      // has to work immediately, or the grant is indistinguishable from a
      // project that routes nowhere.
      const { applyGrants } = await import("./todoist-ingress.js");
      const live = applyGrants(cfg);
      const decision = route(
        event,
        live,
        await (deps.knownOwners?.() ?? []),
        isComment ? ownerOf(parentId) : undefined,
      );
      const who = event.initiator?.email ?? event.initiator?.full_name ?? "todoist";

      if (decision.nearMiss) {
        // Recorded whether or not the task was delivered: the point is that
        // something was asked for and not honoured.
        log(`todoist-webhook: near miss — ${decision.nearMiss}`);
      }

      if (!decision.act) {
        audit({
          action: "webhook", actor: `todoist:${who}`, target: "aibroker",
          outcome: "ignored", reason: decision.reason,
          meta: {
            event: event.event_name,
            task: (event.event_data?.content as string) ?? undefined,
            nearMiss: decision.nearMiss,
          },
        });
        return;
      }

      // Claim a trigger before dispatching, and release it if the dispatch
      // does not land. Honouring another runner's claim is only half an
      // interlock: a path that dispatches and leaves the task unclaimed lets
      // the next poller see an advanced due date with nothing on it, conclude
      // the box was ticked, and run the same sweep again.
      const claiming = event.event_name === "item:completed" && isTrigger(event.event_data ?? {});
      if (claiming) {
        try {
          const { setTaskLabel } = await import("./todoist-reply.js");
          await setTaskLabel(decision.taskId, RUNNING_LABEL, true);
          // Remember when, so a claim nobody comes back for can be released.
          const { recordClaim } = await import("./todoist-claims.js");
          recordClaim(decision.taskId);
        } catch (err) {
          log(`todoist-webhook: could not claim ${decision.taskId} — ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      try {
        // The id rides along so the session can answer on the task it came
        // from. Without it the reply has nowhere to go but a terminal the
        // asker is not looking at.
        // Warn when the title is not unique in its project. Two tasks with the
        // same name are indistinguishable in a list, so an answer posted on one
        // looks — to whoever is watching the other — exactly like being ignored.
        // The session is told, so it can say which id it answered on.
        let twins = 0;
        if (!isComment) {
          try {
            const { countTasksWithTitle } = await import("./todoist-reply.js");
            twins = await countTasksWithTitle(
              String(event.event_data?.project_id ?? ""),
              String(event.event_data?.content ?? ""),
            );
          } catch { /* a lookup failure must not block a delivery */ }
        }
        const twinWarning = twins > 1
          ? `\n\n[note: ${twins} open tasks in this project share this title — say which id you answered on]`
          : "";

        // The project rides along with the task id. A session asked to file a
        // follow-up otherwise has to guess which project is "its own", and a
        // guess from its alias creates a second project the user never sees.
        const fromProject = String(event.event_data?.project_id ?? "");
        const delivered = `${decision.body}${twinWarning}\n\n[todoist:${decision.taskId}${fromProject ? ` in:${fromProject}` : ""}]`;
        const r = await deps.deliver(decision.project, delivered,
          isComment ? { prefix: "[Task:comment]" } : undefined);
        // Remember who took it, so a later comment reaches the same session.
        // Recorded on the way out and only on a real delivery: a task nobody
        // accepted has no owner to inherit.
        if (!isComment && r.outcome === "delivered") rememberOwner(decision.taskId, decision.project);

        // Release a claim the dispatch did not earn. "queued" keeps it — the
        // work IS in flight, the session is simply mid-turn — but a trigger
        // that never reached anyone must go back to being tickable, or the
        // button is dead until someone removes the label by hand.
        if (claiming && r.outcome !== "delivered" && r.outcome !== "queued" && r.outcome !== "spawned") {
          try {
            const { setTaskLabel } = await import("./todoist-reply.js");
            await setTaskLabel(decision.taskId, RUNNING_LABEL, false);
            const { forgetClaim } = await import("./todoist-claims.js");
            forgetClaim(decision.taskId);
            log(`todoist-webhook: released ${RUNNING_LABEL} on ${decision.taskId} — dispatch was ${r.outcome}`);
          } catch { /* the claim is a hint, not a lock; a stuck one is visible */ }
        }
        audit({
          action: "webhook", actor: `todoist:${who}`, target: r.session || decision.project,
          outcome: r.outcome, body: decision.body, reason: r.reason,
          meta: {
            event: event.event_name, taskId: decision.taskId,
            rule: decision.rule, nearMiss: decision.nearMiss,
            duplicateTitles: twins > 1 ? twins : undefined,
          },
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
    clientId: process.env.TODOIST_CLIENT_ID,
    oauthPath: process.env.TODOIST_OAUTH_PATH ?? "/oauth",
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
    log(`todoist-webhook: OAuth landing on ${cfg.oauthPath}` +
        (cfg.clientId ? "" : " — inert until TODOIST_CLIENT_ID is set"));
  });
  server.on("error", (err) => log(`todoist-webhook: server error — ${err.message}`));
  return server;
}
