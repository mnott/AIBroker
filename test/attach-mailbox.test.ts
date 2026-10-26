import "./home-guard.js";
/**
 * A session moved into a Claude background session keeps announcing the pane
 * it started in; the pane you see runs `claude attach <uuid>`. The mailbox must
 * follow the session uuid, not the pane.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { parseAttachUuid, parseSessionIdArg, sameClaudeSession } from "../src/core/claude-attach.js";
import {
  depositToSessionMailbox, drainSessionMailbox, peekSessionMailbox, markMailboxShown,
  setAttachAlias, mailboxKeys,
} from "../src/core/state.js";
import { resolveSenderLabel } from "../src/daemon/core-handlers.js";
import type { SessionSnapshot } from "../src/adapters/iterm/core.js";
import type { IpcRequest } from "../src/types/ipc.js";

const UUID = "cdd93e8d-1111-4222-8333-444455556666";

test("parseAttachUuid reads full uuid and prefix, ignores other claude jobs", () => {
  assert.equal(parseAttachUuid(`claude attach ${UUID}`), UUID);
  assert.equal(parseAttachUuid("/usr/local/bin/claude attach cdd93e8d"), "cdd93e8d");
  assert.equal(parseAttachUuid("claude --resume abc"), undefined);
  assert.equal(parseAttachUuid("claude attach"), undefined);
  assert.equal(parseSessionIdArg(`/x/claude.exe --foo --session-id ${UUID} --bar`), UUID);
  assert.equal(parseSessionIdArg("claude chat"), undefined);
  assert.ok(sameClaudeSession("cdd93e8d", UUID));
  assert.ok(!sameClaudeSession("cdd93e8d", "aaaaaaaa-1111"));
  assert.ok(!sameClaudeSession("cdd", UUID));
});

test("deposit to attach pane, drain by (deadId, uuid) returns it", () => {
  setAttachAlias("PANE-VIEW", "cdd93e8d");
  depositToSessionMailbox("PANE-VIEW", "x", "hello");
  assert.deepEqual(mailboxKeys("DEAD-ID", UUID), ["DEAD-ID", "PANE-VIEW"]);
  const keys = mailboxKeys("DEAD-ID", UUID);
  assert.equal(peekSessionMailbox(keys).length, 1);
  assert.equal(markMailboxShown(keys, 1), 1);
  assert.equal(peekSessionMailbox(keys).length, 0);
  assert.deepEqual(drainSessionMailbox(keys).map((m) => m.content), ["hello"]);
  assert.equal(drainSessionMailbox(keys).length, 0);
});

test("normal case unchanged: no uuid, or a different one, reads only its own mailbox", () => {
  setAttachAlias("PANE-VIEW2", "cdd93e8d");
  depositToSessionMailbox("PANE-OWN", "x", "own");
  depositToSessionMailbox("PANE-VIEW2", "x", "viewer");
  assert.deepEqual(mailboxKeys("PANE-OWN"), ["PANE-OWN"]);
  assert.deepEqual(mailboxKeys("PANE-OWN", "ffffffff-0000"), ["PANE-OWN"]);
  assert.deepEqual(drainSessionMailbox("PANE-OWN").map((m) => m.content), ["own"]);
  assert.equal(peekSessionMailbox("PANE-VIEW2").length, 1);
  drainSessionMailbox("PANE-VIEW2");
});

test("sender label: dead id with matching session uuid is labelled with the attach pane", () => {
  const snap = (o: Partial<SessionSnapshot>): SessionSnapshot =>
    ({ id: "x", name: "n", profileName: "Default", tabTitle: null, tty: "/dev/ttys0", atPrompt: false, paiName: null, ...o });
  const snaps = [snap({ id: "VIEW", paiName: "CaseLeaf", attachUuid: "cdd93e8d", isClaude: true }), snap({ id: "SHELL", isClaude: false })];
  const req = (o: Partial<IpcRequest>) => ({ id: "1", sessionId: "s", method: "m", params: {}, ...o }) as IpcRequest;
  assert.equal(resolveSenderLabel(req({ itermSessionId: "w0t0p0:DEAD", claudeSessionId: UUID }), snaps), "CaseLeaf");
  assert.equal(resolveSenderLabel(req({ itermSessionId: "w0t0p0:SHELL", claudeSessionId: UUID }), snaps), "CaseLeaf");
  assert.equal(resolveSenderLabel(req({ itermSessionId: "w0t0p0:DEAD" }), snaps), "DEAD");
});

test("worker rule intact: PAI_WORKER=1 hook exits silently even with a session payload", () => {
  const hook = join(dirname(fileURLToPath(import.meta.url)), "..", "hooks", "drain-mailbox.mjs");
  const r = spawnSync("node", [hook], {
    env: { ...process.env, PAI_WORKER: "1", ITERM_SESSION_ID: "w0t0p0:DEAD" },
    input: JSON.stringify({ session_id: UUID }),
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "");
});

test("resolveMailboxKeys: uuid only, empty alias table -> scans live panes once for the attach viewer", async () => {
  const { resolveMailboxKeys } = await import("../src/daemon/core-handlers.js");
  const U = "beefbeef-1111-4222-8333-444455556666";
  const snap = { id: "PANE-SCAN", name: "n", profileName: "Default", tabTitle: null, tty: "/dev/ttys1", atPrompt: false, paiName: null, attachUuid: "beefbeef", isClaude: true } as SessionSnapshot;
  let scans = 0;
  const scan = () => { scans++; return [snap]; };
  assert.deepEqual(resolveMailboxKeys(undefined, U, scan), ["PANE-SCAN"]);
  assert.deepEqual(resolveMailboxKeys(undefined, U, scan), ["PANE-SCAN"]);
  assert.equal(scans, 1, "alias known after the first scan");
  assert.deepEqual(resolveMailboxKeys(undefined, "ffffffff-1", () => []), []);
  setAttachAlias("PANE-SCAN", undefined);
});

test("hook with no iTerm/tmux env and a session_id drains the aliased mailbox; PAI_WORKER_ID alone is not a worker", async () => {
  const { createServer } = await import("node:net");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { spawn } = await import("node:child_process");
  const sock = join(mkdtempSync(join(tmpdir(), "drain-")), "s.sock");
  const seen: any[] = [];
  const srv = createServer((c) => {
    c.on("data", (d) => {
      const req = JSON.parse(String(d));
      seen.push(req);
      const result = req.method === "session_mailbox_peek" ? { messages: [{ from: "X", content: "hi-attach", timestamp: Date.now() }] } : { cleared: 1 };
      c.write(JSON.stringify({ id: req.id, ok: true, result }) + "\n");
    });
  });
  await new Promise<void>((r) => srv.listen(sock, r));
  const env: NodeJS.ProcessEnv = { ...process.env, AIBROKER_HOOK_SOCKET: sock, PAI_WORKER_ID: "20261004-114147-57544" };
  for (const k of ["ITERM_SESSION_ID", "TMUX_PANE", "PAI_WORKER"]) delete env[k];
  const child = spawn("node", [join(dirname(fileURLToPath(import.meta.url)), "..", "hooks", "drain-mailbox.mjs")], { env });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stdin.end(JSON.stringify({ session_id: UUID }));
  await new Promise((r) => child.on("close", r));
  srv.close();
  assert.match(out, /hi-attach/);
  assert.equal(seen[0].params.claudeSessionId, UUID);
  assert.equal(seen[0].params.sessionId, undefined);
  assert.equal(seen[1].method, "session_mailbox_ack");
});
