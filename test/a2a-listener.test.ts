/**
 * test/a2a-listener.test.ts — the shared HTTP listener must come up when
 * A2A is configured, whether or not Todoist is.
 *
 * Before this, `createWebhookServer`'s request handler already routed `/a2a`
 * and `/.well-known/agent-card.json` independently of Todoist — but
 * `startTodoistWebhook` only ever called it when `TODOIST_CLIENT_SECRET` was
 * set, so an A2A agent was gated behind an unrelated Todoist secret. These
 * tests pin down the fix: `todoistConfigured() || a2aConfigured()` decides
 * whether the listener binds at all, and each surface behaves independently
 * of whether the other is configured.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWebhookServer, todoistConfigured, sharedListenerShouldStart,
  startTodoistWebhook, type WebhookDeps,
} from "../src/daemon/todoist-webhook.js";
import { a2aConfigured } from "../src/a2a/server.js";
import { expose } from "../src/a2a/exposure.js";

/** Async-safe: restores env only after an async `fn` has actually settled. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return await fn(); }
  finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}

function tmpExposureFile(): string {
  return join(mkdtempSync(join(tmpdir(), "a2a-listener-")), "exposed.json");
}

const NO_A2A_ENV = { AIBROKER_A2A_TOKEN: undefined, AIBROKER_A2A_URL: undefined };
const NO_TODOIST_ENV = { TODOIST_CLIENT_SECRET: undefined, TODOIST_INGRESS_PROJECTS: undefined };

const stubDeps: WebhookDeps = {
  deliver: async () => ({ outcome: "delivered", session: "test" }),
  knownOwners: async () => [],
};

// ── a2aConfigured() ──────────────────────────────────────────────────────────

test("a2aConfigured-token+ true when AIBROKER_A2A_TOKEN is set", async () => {
  const file = tmpExposureFile();
  await withEnv({ ...NO_A2A_ENV, AIBROKER_A2A_TOKEN: "s3cr3t" }, () => {
    assert.equal(a2aConfigured(file), true);
  });
});

test("a2aConfigured-exposed+ true when a session is exposed, no token or URL", async () => {
  const file = tmpExposureFile();
  expose("Home", "test session", file);
  await withEnv(NO_A2A_ENV, () => {
    assert.equal(a2aConfigured(file), true);
  });
});

test("a2aConfigured-none-false+ false when nothing is configured", async () => {
  const file = tmpExposureFile();
  await withEnv(NO_A2A_ENV, () => {
    assert.equal(a2aConfigured(file), false);
  });
});

// ── the start predicate ──────────────────────────────────────────────────────

test("starts-when-only-a2a+ true with A2A configured, Todoist unset", async () => {
  const file = tmpExposureFile();
  expose("Home", undefined, file);
  await withEnv({ ...NO_TODOIST_ENV, ...NO_A2A_ENV }, () => {
    assert.equal(todoistConfigured(), false);
    assert.equal(sharedListenerShouldStart(file), true);
  });
});

test("starts-when-only-todoist+ true with Todoist configured, A2A unset", async () => {
  const file = tmpExposureFile();
  await withEnv({ ...NO_A2A_ENV, TODOIST_CLIENT_SECRET: "todoist-secret" }, () => {
    assert.equal(a2aConfigured(file), false);
    assert.equal(sharedListenerShouldStart(file), true);
  });
});

test("no-start-when-neither+ false with both unset", async () => {
  const file = tmpExposureFile();
  await withEnv({ ...NO_TODOIST_ENV, ...NO_A2A_ENV }, () => {
    assert.equal(sharedListenerShouldStart(file), false);
  });
});

// ── routing: the listener itself, with Todoist off ───────────────────────────

async function withServer<T>(cfg: Parameters<typeof createWebhookServer>[0], fn: (base: string) => Promise<T>): Promise<T> {
  const server = createWebhookServer(cfg, stubDeps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("a2a-route-served-without-todoist+ /.well-known answers without a Todoist config", async () => {
  await withServer(null, async (base) => {
    const res = await fetch(`${base}/.well-known/agent-card.json`);
    assert.equal(res.status, 200);
    const card = await res.json() as { name?: string };
    assert.equal(card.name, "aibroker");
  });
});

test("todoist-route-404s-without-todoist+ a Todoist-shaped POST 404s when cfg is null", async () => {
  await withServer(null, async (base) => {
    const res = await fetch(`${base}/todoist`, { method: "POST", body: "{}" });
    assert.equal(res.status, 404);
  });
});

// ── bind-time log line, only-A2A case ────────────────────────────────────────

test("only-a2a-bind-logs-a2a-surface+ the bind-time log line names a2a, not todoist", async () => {
  const file = tmpExposureFile();
  expose("Home", undefined, file);
  // A distinct, unlikely-to-collide port — startTodoistWebhook binds a real
  // socket (it is the function under test), so this must not fight a
  // developer's own daemon on the default 8766.
  await withEnv({ ...NO_TODOIST_ENV, AIBROKER_A2A_TOKEN: "s3cr3t", TODOIST_WEBHOOK_PORT: "18766" }, async () => {
    const lines: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
      lines.push(String(chunk));
      return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write;

    let server: ReturnType<typeof startTodoistWebhook> = null;
    try {
      server = startTodoistWebhook(stubDeps);
      assert.ok(server, "expected a server when A2A is configured");
      await new Promise<void>((resolve) => server!.once("listening", resolve));
    } finally {
      process.stderr.write = original;
    }

    try {
      const bindLine = lines.find((l) => l.includes("shared-listener: listening"));
      assert.ok(bindLine, `expected a shared-listener bind log line, got: ${JSON.stringify(lines)}`);
      assert.match(bindLine!, /a2a/);
      assert.doesNotMatch(bindLine!, /todoist \(/);
    } finally {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
  });
});
