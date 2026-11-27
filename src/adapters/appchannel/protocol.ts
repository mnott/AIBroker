/**
 * adapters/appchannel/protocol.ts — wire protocol for the generic app channel
 * (a chat pane inside an app, e.g. CaseLeaf). Pure: no IO. JSON over WebSocket, `v:1`.
 */

export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 64 * 1024;
export const MAX_SELECTION = 8 * 1024;
export const MAX_MARKS = 200;
const MAX_ID = 200;
const MAX_TEXT = 32 * 1024;
const MAX_TITLE = 500;

export interface DocContext { fileId: string; page?: number; selection?: string; marks?: string[]; title?: string }
export interface MessageContext { doc?: DocContext; extra?: Record<string, unknown> }

export type ClientFrame =
  | { v: 1; type: "hello"; app: string; paneId: string; token: string }
  | { v: 1; type: "message"; id: string; session: string; text: string; context?: MessageContext }
  | { v: 1; type: "confirm"; actionId: string; approve: boolean }
  | { v: 1; type: "ping" };

export interface ActionSpec { kind: "reply" | "mark" | "revise" | (string & {}); args: Record<string, unknown> }

export type HubFrame =
  | { v: 1; type: "ready"; sessions?: string[] }
  | { v: 1; type: "reply"; session: string; text: string; inReplyTo?: string }
  | { v: 1; type: "action"; actionId: string; session: string; action: ActionSpec; needsConfirm: true }
  | { v: 1; type: "ack"; id: string }
  | { v: 1; type: "error"; code: string; message: string }
  | { v: 1; type: "pong" };

export type ParseResult = { ok: true; frame: ClientFrame } | { ok: false; error: string };

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const str = (x: unknown, max: number, min = 1): x is string => typeof x === "string" && x.length >= min && x.length <= max;

function parseContext(c: unknown): MessageContext | string {
  if (!isObj(c)) return "context must be an object";
  const out: MessageContext = {};
  if (c.doc !== undefined) {
    const d = c.doc;
    if (!isObj(d)) return "context.doc must be an object";
    if (!str(d.fileId, MAX_ID)) return "context.doc.fileId invalid";
    const doc: DocContext = { fileId: d.fileId };
    if (d.page !== undefined) {
      if (typeof d.page !== "number" || !Number.isInteger(d.page) || d.page < 0 || d.page > 1_000_000) return "context.doc.page invalid";
      doc.page = d.page;
    }
    if (d.selection !== undefined) {
      if (!str(d.selection, MAX_SELECTION, 0)) return "context.doc.selection invalid or too long";
      doc.selection = d.selection;
    }
    if (d.marks !== undefined) {
      if (!Array.isArray(d.marks) || d.marks.length > MAX_MARKS || !d.marks.every((m) => str(m, MAX_ID))) return "context.doc.marks invalid";
      doc.marks = d.marks as string[];
    }
    if (d.title !== undefined) {
      if (!str(d.title, MAX_TITLE, 0)) return "context.doc.title invalid";
      doc.title = d.title;
    }
    out.doc = doc;
  }
  if (c.extra !== undefined) {
    if (!isObj(c.extra)) return "context.extra must be an object";
    out.extra = c.extra;
  }
  return out;
}

/** Strict parse + validation of one client frame (raw JSON text). */
export function parseClientFrame(raw: string | Buffer): ParseResult {
  const size = typeof raw === "string" ? Buffer.byteLength(raw) : raw.length;
  if (size > MAX_FRAME_BYTES) return { ok: false, error: "frame too large" };
  let j: unknown;
  try { j = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8")); } catch { return { ok: false, error: "invalid JSON" }; }
  if (!isObj(j)) return { ok: false, error: "frame must be an object" };
  if (j.v !== PROTOCOL_VERSION) return { ok: false, error: "unsupported version" };
  switch (j.type) {
    case "hello":
      if (!str(j.app, 64) || !str(j.paneId, MAX_ID) || !str(j.token, 512)) return { ok: false, error: "hello needs app, paneId, token" };
      return { ok: true, frame: { v: 1, type: "hello", app: j.app, paneId: j.paneId, token: j.token } };
    case "message": {
      if (!str(j.id, MAX_ID) || !str(j.session, MAX_ID) || !str(j.text, MAX_TEXT)) return { ok: false, error: "message needs id, session, text" };
      const f: ClientFrame = { v: 1, type: "message", id: j.id, session: j.session, text: j.text };
      if (j.context !== undefined) {
        const c = parseContext(j.context);
        if (typeof c === "string") return { ok: false, error: c };
        f.context = c;
      }
      return { ok: true, frame: f };
    }
    case "confirm":
      if (!str(j.actionId, MAX_ID) || typeof j.approve !== "boolean") return { ok: false, error: "confirm needs actionId, approve" };
      return { ok: true, frame: { v: 1, type: "confirm", actionId: j.actionId, approve: j.approve } };
    case "ping":
      return { ok: true, frame: { v: 1, type: "ping" } };
    default:
      return { ok: false, error: "unknown frame type" };
  }
}

export function sanitizeApp(app: string): string {
  return app.replace(/[^A-Za-z0-9_-]/g, "") || "app";
}

/** Ids: strip brackets, whitespace, control chars so the prefix cannot be broken out of. */
function cleanId(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f\s\[\]"=,]/g, "").slice(0, MAX_ID);
}

function oneLine(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
}

/** e.g. `[CaseLeaf:doc file=<id> page=3 marks=a,b] "selected text" ` ("" without context). */
export function formatChannelPrefix(app: string, context?: MessageContext): string {
  const doc = context?.doc;
  if (!doc) return "";
  const parts = [`${sanitizeApp(app)}:doc`, `file=${cleanId(doc.fileId)}`];
  if (doc.page !== undefined) parts.push(`page=${doc.page}`);
  if (doc.marks?.length) parts.push(`marks=${doc.marks.map(cleanId).filter(Boolean).join(",")}`);
  let out = `[${parts.join(" ")}] `;
  if (doc.selection) {
    const sel = oneLine(doc.selection).replace(/"/g, "'").slice(0, MAX_SELECTION);
    if (sel) out += `"${sel}" `;
  }
  return out;
}

/** The full single-line string typed into the session. */
export function formatInbound(app: string, text: string, context?: MessageContext): string {
  const body = oneLine(text);
  return context?.doc ? formatChannelPrefix(app, context) + body : `[${sanitizeApp(app)}] ${body}`;
}
