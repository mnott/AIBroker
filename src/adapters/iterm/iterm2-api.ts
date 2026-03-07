/**
 * adapters/iterm/iterm2-api.ts — Native iTerm2 API client via WebSocket + protobuf.
 *
 * Connects to iTerm2's local API (unix socket or TCP) to perform operations
 * that aren't possible via AppleScript alone, such as setting the tab title
 * override (the persistent title set by double-click rename).
 *
 * Zero external dependencies beyond `ws` (already in the project).
 * Replaces the Python `iterm2` module dependency.
 */

import { WebSocket } from "ws";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createConnection } from "node:net";
import http from "node:http";

import { log } from "../../core/log.js";

// ── Minimal protobuf encoder (hand-rolled for the specific messages we need) ──

function encodeVarint(v: number): Buffer {
  const bytes: number[] = [];
  v >>>= 0;
  while (v > 0x7f) { bytes.push((v & 0x7f) | 0x80); v >>>= 7; }
  bytes.push(v & 0x7f);
  return Buffer.from(bytes);
}

function encodeTag(fieldNumber: number, wireType: number): Buffer {
  return encodeVarint((fieldNumber << 3) | wireType);
}

function encodeString(fieldNumber: number, value: string): Buffer {
  const buf = Buffer.from(value, "utf-8");
  return Buffer.concat([encodeTag(fieldNumber, 2), encodeVarint(buf.length), buf]);
}

function encodeDouble(fieldNumber: number, value: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeDoubleLE(value);
  return Buffer.concat([encodeTag(fieldNumber, 1), buf]);
}

function encodeLengthDelimited(fieldNumber: number, buf: Buffer): Buffer {
  return Buffer.concat([encodeTag(fieldNumber, 2), encodeVarint(buf.length), buf]);
}

// ── Minimal protobuf decoder ──

interface DecodedField {
  fn: number;
  wt: number;
  value: number | Buffer;
  offset: number;
}

function decodeVarintAt(buf: Buffer, off: number): { value: number; offset: number } {
  let value = 0, shift = 0;
  while (off < buf.length) {
    const b = buf[off++];
    value |= (b & 0x7f) << shift;
    shift += 7;
    if (!(b & 0x80)) break;
  }
  return { value, offset: off };
}

function decodeField(buf: Buffer, off: number): DecodedField {
  const { value: tag, offset: o1 } = decodeVarintAt(buf, off);
  const fn = tag >>> 3, wt = tag & 0x7;
  if (wt === 0) {
    const { value, offset: o2 } = decodeVarintAt(buf, o1);
    return { fn, wt, value, offset: o2 };
  }
  if (wt === 1) return { fn, wt, value: buf.slice(o1, o1 + 8), offset: o1 + 8 };
  if (wt === 2) {
    const { value: len, offset: o2 } = decodeVarintAt(buf, o1);
    return { fn, wt, value: buf.slice(o2, o2 + len), offset: o2 + len };
  }
  if (wt === 5) return { fn, wt, value: buf.slice(o1, o1 + 4), offset: o1 + 4 };
  throw new Error(`Unknown protobuf wire type ${wt}`);
}

function parseFields(buf: Buffer): DecodedField[] {
  const results: DecodedField[] = [];
  let off = 0;
  try {
    while (off < buf.length) {
      const f = decodeField(buf, off);
      results.push(f);
      off = f.offset;
    }
  } catch { /* partial parse is OK */ }
  return results;
}

// ── Message builders ──

function buildListSessionsRequest(id: number): Buffer {
  return Buffer.concat([
    Buffer.concat([encodeTag(1, 0), encodeVarint(id)]),
    encodeLengthDelimited(106, Buffer.alloc(0)),
  ]);
}

function buildSetTitleRequest(id: number, tabId: string, title: string): Buffer {
  const escaped = title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const invocation = `iterm2.set_title(title: "${escaped}")`;
  const method = encodeString(1, tabId);
  const inner = Buffer.concat([
    encodeString(5, invocation),
    encodeDouble(6, -1.0),
    encodeLengthDelimited(7, method),
  ]);
  return Buffer.concat([
    Buffer.concat([encodeTag(1, 0), encodeVarint(id)]),
    encodeLengthDelimited(132, inner),
  ]);
}

// ── Response parsing ──

/**
 * Find the tab_id for a given iTerm2 session UUID in a list_sessions response.
 *
 * Response structure (from protobuf dump):
 *   response.list_sessions_response (field 106)
 *     .windows (field 1, repeated)
 *       .tabs (field 1, repeated)
 *         .tab_id (field 2, string like "77")
 *         .root (field 3, contains sessions)
 *           ...nested...
 *             .session.unique_identifier (field 1, UUID string)
 */
function findTabIdForSession(buf: Buffer, targetSessionId: string): string | null {
  for (const f106 of parseFields(buf)) {
    if (f106.fn !== 106 || f106.wt !== 2) continue;
    for (const fWin of parseFields(f106.value as Buffer)) {
      if (fWin.fn !== 1 || fWin.wt !== 2) continue;
      for (const fTab of parseFields(fWin.value as Buffer)) {
        if (fTab.fn !== 1 || fTab.wt !== 2) continue;
        const tabFields = parseFields(fTab.value as Buffer);
        let tabId: string | null = null;
        for (const tf of tabFields) {
          if (tf.fn === 2 && tf.wt === 2) {
            const s = (tf.value as Buffer).toString("utf-8");
            if (/^\d+$/.test(s)) tabId = s;
          }
        }
        // Check if this tab contains our session UUID anywhere in its data
        if (tabId && (fTab.value as Buffer).toString("utf-8").includes(targetSessionId)) {
          return tabId;
        }
      }
    }
  }
  return null;
}

// ── Auth ──

function getCookieAndKey(): { cookie: string; key: string } | null {
  try {
    const result = execSync(
      `osascript -e 'tell application "iTerm2" to request cookie and key for app named "AIBroker"'`,
      { timeout: 5000, encoding: "utf-8" },
    ).trim();
    const [cookie, key] = result.split(" ");
    if (!cookie || !key) return null;
    return { cookie, key };
  } catch {
    return null;
  }
}

// ── Connection ──

const SOCKET_PATH = join(homedir(), "Library", "Application Support", "iTerm2", "private", "socket");
const TIMEOUT_MS = 5000;

function createIterm2WebSocket(auth: { cookie: string; key: string }): WebSocket {
  const headers = {
    "origin": "ws://localhost/",
    "x-iterm2-library-version": "node 1.0",
    "x-iterm2-disable-auth-ui": "true",
    "x-iterm2-cookie": auth.cookie,
    "x-iterm2-key": auth.key,
    "x-iterm2-advisory-name": "AIBroker",
  };

  if (existsSync(SOCKET_PATH)) {
    const agent = new http.Agent();
    (agent as any).createConnection = (_: unknown, cb: (...args: unknown[]) => void) =>
      createConnection(SOCKET_PATH, cb as () => void);
    return new WebSocket("ws://localhost/", ["api.iterm2.com"], { headers, agent });
  }

  return new WebSocket("ws://localhost:1912", ["api.iterm2.com"], { headers });
}

// ── Public API ──

/**
 * Set the tab title override for the tab containing a given iTerm2 session.
 * This is the same as double-click renaming a tab — it persists until changed.
 *
 * Uses iTerm2's native WebSocket API (unix socket at
 * ~/Library/Application Support/iTerm2/private/socket).
 * No Python dependency required.
 */
export async function iterm2SetTabTitle(sessionId: string, newTitle: string): Promise<void> {
  const auth = getCookieAndKey();
  if (!auth) throw new Error("Failed to get iTerm2 auth cookie");

  const ws = createIterm2WebSocket(auth);

  return new Promise<void>((resolve, reject) => {
    let msgId = 0;
    const pending = new Map<number, string>();
    const timer = setTimeout(() => { ws.close(); reject(new Error("Timeout")); }, TIMEOUT_MS);

    ws.on("open", () => {
      const id = ++msgId;
      pending.set(id, "list");
      ws.send(buildListSessionsRequest(id));
    });

    ws.on("message", (data: Buffer) => {
      const buf = Buffer.from(data);
      // Extract response id (field 1, varint)
      let responseId = -1;
      try {
        let off = 0;
        while (off < buf.length) {
          const f = decodeField(buf, off);
          off = f.offset;
          if (f.fn === 1 && f.wt === 0) { responseId = f.value as number; break; }
        }
      } catch { /* */ }

      const type = pending.get(responseId);
      pending.delete(responseId);

      if (type === "list") {
        const tabId = findTabIdForSession(buf, sessionId);
        if (!tabId) {
          clearTimeout(timer);
          ws.close();
          reject(new Error(`Session ${sessionId.slice(0, 8)}... not found in iTerm2`));
          return;
        }
        const id = ++msgId;
        pending.set(id, "set");
        ws.send(buildSetTitleRequest(id, tabId, newTitle));
      } else if (type === "set") {
        clearTimeout(timer);
        ws.close();
        resolve();
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
