/**
 * test/router.test.ts — Unit tests for MessageRouter.
 *
 * Run: npx tsx --test test/router.test.ts
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { MessageRouter } from "../src/core/router.js";
import type { Backend } from "../src/types/backend.js";

function fakeBackend(name: string, type: string = "api"): Backend {
  return { name, type } as Backend;
}

describe("MessageRouter", () => {
  let router: MessageRouter;

  beforeEach(() => {
    router = new MessageRouter();
  });

  it("starts with no default backend", () => {
    assert.equal(router.defaultBackend, null);
  });

  it("sets and retrieves default backend", () => {
    const backend = fakeBackend("anthropic");
    router.setDefaultBackend(backend);
    assert.equal(router.defaultBackend, backend);
    assert.equal(router.defaultBackend!.name, "anthropic");
  });

  it("routes to default backend when no session backend set", () => {
    const backend = fakeBackend("anthropic");
    router.setDefaultBackend(backend);
    assert.equal(router.route("session-1"), backend);
  });

  it("returns null when no default and no session backend", () => {
    assert.equal(router.route("session-1"), null);
  });

  it("routes to session-specific backend", () => {
    const defaultBackend = fakeBackend("default");
    const sessionBackend = fakeBackend("session-specific");
    router.setDefaultBackend(defaultBackend);
    router.setBackend("session-1", sessionBackend);
    assert.equal(router.route("session-1"), sessionBackend);
  });

  it("falls back to default for other sessions", () => {
    const defaultBackend = fakeBackend("default");
    const sessionBackend = fakeBackend("session-specific");
    router.setDefaultBackend(defaultBackend);
    router.setBackend("session-1", sessionBackend);
    assert.equal(router.route("session-2"), defaultBackend);
  });

  it("removes session backend", () => {
    const defaultBackend = fakeBackend("default");
    const sessionBackend = fakeBackend("session-specific");
    router.setDefaultBackend(defaultBackend);
    router.setBackend("session-1", sessionBackend);
    router.removeBackend("session-1");
    assert.equal(router.route("session-1"), defaultBackend);
  });

  it("lists all session backends", () => {
    router.setBackend("s1", fakeBackend("backend-a", "api"));
    router.setBackend("s2", fakeBackend("backend-b", "iterm2"));
    const list = router.listBackends();
    assert.equal(list.length, 2);
    assert.ok(list.some(b => b.sessionId === "s1" && b.backend === "backend-a" && b.type === "api"));
    assert.ok(list.some(b => b.sessionId === "s2" && b.backend === "backend-b" && b.type === "iterm2"));
  });

  it("returns empty list when no session backends", () => {
    assert.deepEqual(router.listBackends(), []);
  });

  it("overwrites session backend on re-set", () => {
    router.setBackend("s1", fakeBackend("old"));
    router.setBackend("s1", fakeBackend("new"));
    assert.equal(router.route("s1")!.name, "new");
    assert.equal(router.listBackends().length, 1);
  });
});
