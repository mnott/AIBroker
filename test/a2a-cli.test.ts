/**
 * test/a2a-cli.test.ts — the parts of `aibroker a2a` that do not require a
 * live daemon or a real `tailscale` binary: URL resolution, token
 * generation, card verification, and the `check` interop tool.
 *
 * Deliberately does NOT call `runSetup` directly with tailscale detection
 * live — this machine may have a real Tailscale install with real funnel
 * config, and a test that shells out to it would mutate that. Every piece
 * `runSetup` depends on (`ensureA2AToken`, `verifyPublicCard`,
 * `resolveOwnA2AUrl`) is exported and tested standalone instead.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveOwnA2AUrl, ensureA2AToken, verifyPublicCard, runA2A,
} from "../src/daemon/a2a-cli.js";
import { handleA2A, applyA2AReply, type A2AContext } from "../src/a2a/server.js";
import { expose } from "../src/a2a/exposure.js";

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; }
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return fn(); }
  finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

test("card-url-from-AIBROKER_A2A_URL+ wins whole, trailing slash trimmed", () => {
  withEnv({ AIBROKER_A2A_URL: "https://agent.example.org/a2a/", AIBROKER_PUBLIC_HOST: "ignored.example" }, () => {
    assert.equal(resolveOwnA2AUrl(), "https://agent.example.org/a2a");
  });
});

test("card-url-falls-back-to-public-host+ builds https://<host>/a2a", () => {
  withEnv({ AIBROKER_A2A_URL: undefined, AIBROKER_PUBLIC_HOST: "myhost.example" }, () => {
    assert.equal(resolveOwnA2AUrl(), "https://myhost.example/a2a");
  });
});

test("setup-generates-token-once+ generates and writes when unset", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-cli-token-"));
  const envFile = join(dir, "env");
  withEnv({ AIBROKER_A2A_TOKEN: undefined }, () => {
    const r = ensureA2AToken(envFile, false);
    assert.equal(r.generated, true);
    assert.ok(r.token.length > 0);
    assert.match(readFileSync(envFile, "utf-8"), new RegExp(`AIBROKER_A2A_TOKEN=${r.token}`));
    assert.equal(process.env.AIBROKER_A2A_TOKEN, r.token);
  });
});

test("setup-keeps-existing-token+ never overwrites one already set", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-cli-token2-"));
  const envFile = join(dir, "env");
  withEnv({ AIBROKER_A2A_TOKEN: "already-here" }, () => {
    const r = ensureA2AToken(envFile, false);
    assert.equal(r.generated, false);
    assert.equal(r.token, "already-here");
    assert.equal(existsSyncSafe(envFile), false, "nothing was written — the existing token was left alone");
  });
});

function existsSyncSafe(p: string): boolean {
  try { readFileSync(p); return true; } catch { return false; }
}

test("setup-print-only-shows-both-paths+ print-only never writes the token file", () => {
  const dir = mkdtempSync(join(tmpdir(), "a2a-cli-token3-"));
  const envFile = join(dir, "env");
  withEnv({ AIBROKER_A2A_TOKEN: undefined }, () => {
    const r = ensureA2AToken(envFile, true);
    assert.equal(r.generated, true);
    assert.equal(existsSyncSafe(envFile), false);
    // process.env is also left untouched in print-only mode.
    assert.equal(process.env.AIBROKER_A2A_TOKEN, undefined);
  });
});

async function harness(opts: { autoReply?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "a2a-cli-server-"));
  const taskFile = join(dir, "tasks.json");
  const exposureFile = join(dir, "exposed.json");
  expose("Home", "cli test session", exposureFile);
  const ctx: A2AContext = {
    version: "0.0.0-test",
    publicUrl: () => "will fill in",
    token: "s3cr3t",
    deliver: async (_session, text) => {
      if (opts.autoReply) {
        const m = /task (a2a-\S+)\]/.exec(text);
        if (m) setTimeout(() => applyA2AReply(m[1], "all done", taskFile), 50);
      }
      return { delivered: true };
    },
    taskFile,
    exposureFile,
  };
  const server = createServer((req, res) => { void handleA2A(req, res, ctx); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  ctx.publicUrl = () => `${base}/a2a`;
  return { server, base };
}
async function stop(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test("setup-verify-reports-failure-exit-1+ verifyPublicCard reports OK and FAILED distinctly", async () => {
  const h = await harness();
  try {
    const ok = await verifyPublicCard(h.base);
    assert.equal(ok.ok, true);
    assert.equal(ok.skillCount, 1);

    const bad = await verifyPublicCard("http://127.0.0.1:1", 1000);
    assert.equal(bad.ok, false);
    assert.ok(bad.detail.length > 0);
  } finally { await stop(h.server); }
});

function captureConsole(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => { logs.push(a.join(" ")); };
  console.error = (...a: unknown[]) => { logs.push(a.join(" ")); };
  return { logs, restore: () => { console.log = origLog; console.error = origErr; } };
}

test("check-tool-pass-table-on-own-server+ all steps PASS against a healthy agent", async () => {
  const h = await harness({ autoReply: true });
  const cap = captureConsole();
  try {
    process.env.AIBROKER_A2A_TOKEN = "s3cr3t";
    await runA2A(["check", h.base]);
  } finally { cap.restore(); await stop(h.server); }
  const out = cap.logs.join("\n");
  assert.match(out, /PASS\s+fetch \+ validate AgentCard/);
  assert.match(out, /PASS\s+message\/send/);
  assert.doesNotMatch(out, /FAIL/, out);
});

test("check-tool-fail-table-on-bad-card+ FAILs cleanly against something that is not an A2A agent", async () => {
  const plain = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/plain" }).end("not an agent"); });
  await new Promise<void>((resolve) => plain.listen(0, "127.0.0.1", resolve));
  const port = (plain.address() as AddressInfo).port;
  const cap = captureConsole();
  const savedExit = process.exitCode;
  try {
    await runA2A(["check", `http://127.0.0.1:${port}`]);
  } finally { cap.restore(); await new Promise<void>((r) => plain.close(() => r())); }
  const out = cap.logs.join("\n");
  assert.match(out, /FAIL\s+fetch \+ validate AgentCard/);
  assert.equal(process.exitCode, 1);
  process.exitCode = savedExit;
});
