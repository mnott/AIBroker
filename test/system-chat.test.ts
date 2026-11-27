import "./home-guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { pushRouting, SYSTEM_SESSION_ID, SYSTEM_SESSION_NAME } from "../src/adapters/pailot/system-chat.js";

test("resolved session routes to itself", () => {
  assert.deepEqual(pushRouting("abc"), { sessionId: "abc", isSystem: false });
});

test("no session routes to the global System chat", () => {
  assert.equal(SYSTEM_SESSION_ID, "global");
  assert.equal(SYSTEM_SESSION_NAME, "System");
  assert.deepEqual(pushRouting(undefined), { sessionId: "global", isSystem: true });
});
