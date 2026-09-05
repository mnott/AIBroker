/**
 * a2a/client.ts — AIBroker as an A2A client: task an OUTSIDE agent's
 * exposed skill and poll for its answer.
 *
 * Fetch-only, no dependencies, works against any A2A v0.3.0 server —
 * that is the point of `aibroker a2a check` in a2a-cli.ts, which runs
 * this client against an arbitrary remote agent and reports pass/fail per
 * step rather than assuming aibroker's own server is the only target.
 */

import { validateAgentCard, validateTask } from "./schema/validate.js";
import type { AgentCard, Task, TaskState } from "./schema/types.js";
import { ag2Part } from "./agentish-extension.js";

export interface FetchAgentCardResult {
  ok: boolean;
  card?: AgentCard;
  errors: string[];
}

/** GET <base>/.well-known/agent-card.json, validated against the vendored schema. */
export async function fetchAgentCard(baseUrl: string): Promise<FetchAgentCardResult> {
  const url = new URL("/.well-known/agent-card.json", baseUrl).toString();
  let res: Response;
  try {
    res = await fetch(url);
  } catch (e) {
    return { ok: false, errors: [`fetch failed: ${e instanceof Error ? e.message : String(e)}`] };
  }
  if (!res.ok) return { ok: false, errors: [`HTTP ${res.status} fetching ${url}`] };
  let body: unknown;
  try {
    body = await res.json();
  } catch (e) {
    return { ok: false, errors: [`response is not JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }
  const v = validateAgentCard(body);
  return { ok: v.ok, card: v.ok ? (body as AgentCard) : undefined, errors: v.errors };
}

let seq = 0;
function nextId(): string { seq += 1; return `aibroker-client-${Date.now().toString(36)}-${seq}`; }
function nextMessageId(): string { return `msg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }

async function rpc(a2aUrl: string, method: string, params: Record<string, unknown>, token?: string): Promise<
  { ok: true; result: unknown } | { ok: false; error: string }
> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(a2aUrl, {
      method: "POST", headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId(), method, params }),
    });
  } catch (e) {
    return { ok: false, error: `fetch failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  let body: { result?: unknown; error?: { code: number; message: string } };
  try {
    body = await res.json() as typeof body;
  } catch (e) {
    return { ok: false, error: `response is not JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (body.error) return { ok: false, error: `[${body.error.code}] ${body.error.message}` };
  return { ok: true, result: body.result };
}

export interface SendMessageResult {
  ok: boolean;
  task?: Task;
  error?: string;
}

export interface SendMessageOptions {
  /** Which exposed skill/session to target. Optional because a generic A2A
   *  agent — the target of `aibroker a2a check` — need not have this concept
   *  at all; aibroker's own server requires it (or message.metadata.session). */
  skillId?: string;
  text: string;
  /** Tag the text part as an AG2 (Agentish v2) message per the extension. */
  ag2?: boolean;
  token?: string;
  contextId?: string;
  agentName?: string;
}

export async function sendMessage(a2aUrl: string, opts: SendMessageOptions): Promise<SendMessageResult> {
  const part = opts.ag2 ? ag2Part(opts.text) : { kind: "text" as const, text: opts.text };
  const r = await rpc(a2aUrl, "message/send", {
    skillId: opts.skillId,
    agentName: opts.agentName,
    message: {
      kind: "message", role: "user", messageId: nextMessageId(),
      contextId: opts.contextId, parts: [part],
    },
  }, opts.token);
  if (!r.ok) return { ok: false, error: r.error };
  const v = validateTask(r.result);
  if (!v.ok) return { ok: false, error: `server returned an invalid Task: ${v.errors.join("; ")}` };
  return { ok: true, task: r.result as Task };
}

export async function getTask(a2aUrl: string, taskId: string, token?: string): Promise<SendMessageResult> {
  const r = await rpc(a2aUrl, "tasks/get", { id: taskId }, token);
  if (!r.ok) return { ok: false, error: r.error };
  const v = validateTask(r.result);
  if (!v.ok) return { ok: false, error: `server returned an invalid Task: ${v.errors.join("; ")}` };
  return { ok: true, task: r.result as Task };
}

export async function cancelTask(a2aUrl: string, taskId: string, token?: string): Promise<SendMessageResult> {
  const r = await rpc(a2aUrl, "tasks/cancel", { id: taskId }, token);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, task: r.result as Task };
}

const TERMINAL: ReadonlySet<TaskState> = new Set(["completed", "canceled", "failed", "rejected"]);

export interface PollOptions {
  intervalMs?: number;
  timeoutMs?: number;
  token?: string;
}

/** Poll tasks/get until the task reaches a terminal state or the timeout elapses. */
export async function pollUntilDone(a2aUrl: string, taskId: string, opts: PollOptions = {}): Promise<SendMessageResult> {
  const interval = opts.intervalMs ?? 2000;
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  for (;;) {
    const r = await getTask(a2aUrl, taskId, opts.token);
    if (!r.ok) return r;
    if (r.task && TERMINAL.has(r.task.status.state)) return r;
    if (Date.now() >= deadline) return { ok: false, error: "timed out waiting for a terminal state", task: r.task };
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
