import "./home-guard.js";
/**
 * A Claude background session (no tty) inherits TERM_SESSION_ID from the pane
 * that spawned it. It is its own sender, not that pane.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCallerPane, resolveSenderLabel } from "../src/daemon/core-handlers.js";
import { parseClaudeProc } from "../src/ipc/client.js";
import { selfSendError } from "../src/core/session-match.js";
import type { IpcRequest } from "../src/types/ipc.js";
import type { SessionSnapshot } from "../src/adapters/iterm/core.js";

const PANE = "1F355502-0000-4000-8000-000000000001";
const OTHER = "2A000000-0000-4000-8000-000000000002";
const snaps = [
  { id: PANE, name: "PAI", tty: "/dev/ttys001", paiName: "PAI", isClaude: true },
  { id: OTHER, name: "Other", tty: "/dev/ttys002", paiName: "Other", isClaude: true },
] as unknown as SessionSnapshot[];

const base = (o: Partial<IpcRequest>): IpcRequest =>
  ({ id: "r", sessionId: `w1t0p0:${PANE}`, itermSessionId: `w1t0p0:${PANE}`, method: "x", params: {}, ...o }) as IpcRequest;

test("bg caller is not resolved to the pane", () => {
  // The client withholds the inherited ids for a background caller.
  const req = base({ itermSessionId: undefined, sessionId: "0274a882-aaaa", background: true, claudeName: "bg-spare" });
  assert.equal(resolveCallerPane(req, snaps), undefined);
  assert.equal(resolveSenderLabel(req, snaps), "bg-spare");
});

test("bg flag alone defeats a leaked claim", () => {
  assert.equal(resolveCallerPane(base({ background: true }), snaps), undefined);
});

test("claude tty differing from the claimed pane's tty is not that pane", () => {
  assert.equal(resolveCallerPane(base({ claudeTty: "/dev/ttys009" }), snaps), undefined);
});

test("genuine pane caller still resolved", () => {
  assert.equal(resolveCallerPane(base({ claudeTty: "/dev/ttys001" }), snaps)?.id, PANE);
  assert.equal(resolveCallerPane(base({}), snaps)?.id, PANE);
});

test("send from bg caller to the inherited pane is allowed; real self-send refused", () => {
  const bg = base({ itermSessionId: undefined, sessionId: "0274a882", background: true });
  assert.equal(selfSendError(resolveCallerPane(bg, snaps)?.id, PANE, "bg", "PAI"), null);
  assert.ok(selfSendError(resolveCallerPane(base({}), snaps)?.id, PANE, "PAI", "PAI"));
});

test("parseClaudeProc: tty and bg name", () => {
  assert.deepEqual(parseClaudeProc("??", "claude bg-spare"), { tty: null, name: "bg-spare" });
  assert.equal(parseClaudeProc("ttys001", "/usr/bin/claude --resume x --name PAI")?.tty, "/dev/ttys001");
  assert.equal(parseClaudeProc("ttys001", "/usr/bin/claude --resume x --name PAI")?.name, "PAI");
  assert.equal(parseClaudeProc("ttys001", "node server.js"), undefined);
});
