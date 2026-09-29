import "./home-guard.js";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatHubStatus } from "../src/daemon/status-format.js";
import { validateHubStatus } from "../src/ipc/validate.js";
import { transportLabel } from "../src/transport/policy.js";

describe("transport in status", () => {
  it("labels the permitted transports and why", () => {
    assert.equal(transportLabel({}, "linux"), "tmux (linux)");
    assert.equal(transportLabel({}, "darwin"), "iterm+tmux (auto)");
    assert.equal(transportLabel({ AIBROKER_TRANSPORT: "iterm" }, "darwin"), "iterm (env)");
  });
  it("prints a Transport line from the daemon's result", () => {
    const s = validateHubStatus({ version: "1", adapters: [], activeSessions: 0, transport: "tmux (linux)" });
    assert.equal(s.transport, "tmux (linux)");
    assert.ok(formatHubStatus(s).includes("  Transport:      tmux (linux)"));
  });
  it("an older daemon without the field reads unknown", () => {
    assert.equal(validateHubStatus({ version: "1" }).transport, "unknown");
  });
});
