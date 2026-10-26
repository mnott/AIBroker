import "./home-guard.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { send } from "../src/daemon/send-cli.js";
import { isTerminalAddress, terminalPluginId } from "../src/transport/policy.js";

const mk = (reply: Record<string, unknown>, stdin = "") => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const lines: string[] = [];
  return { calls, lines, deps: { call: async (m: string, p: Record<string, unknown>) => { calls.push([m, p]); return reply; }, readStdin: async () => stdin, out: (l: string) => lines.push(l) } };
};

test("send joins the words and calls send_to_session with noReply", async () => {
  const m = mk({ delivered: true, name: "api" });
  assert.equal(await send(["api", "hello", "there"], m.deps), 0);
  assert.deepEqual(m.calls, [["send_to_session", { target: "api", message: "hello there", noReply: true }]]);
  assert.equal(m.lines[0], "Sent to api");
});

test("send reads stdin when there are no words, and reports queued honestly", async () => {
  const m = mk({ delivered: false, name: "api" }, "multi\nline\n");
  assert.equal(await send(["api"], m.deps), 0);
  assert.equal(m.calls[0][1].message, "multi\nline");
  assert.match(m.lines[0], /^Queued for api/);
});

test("send with no target or no text fails; a daemon error fails", async () => {
  assert.equal(await send([], mk({}).deps), 1);
  assert.equal(await send(["api"], mk({}, "").deps), 1);
  const bad = mk({});
  bad.deps.call = async () => { throw new Error("Session \"x\" not found"); };
  assert.equal(await send(["x", "hi"], bad.deps), 1);
});

test("AIBP terminal plugin id follows the transport; either label is a terminal address", () => {
  assert.equal(terminalPluginId({}, "linux"), "tmux");
  assert.equal(terminalPluginId({}, "darwin"), "iterm");
  assert.equal(terminalPluginId({ AIBROKER_TRANSPORT: "tmux" }, "darwin"), "tmux");
  assert.ok(isTerminalAddress("terminal:iterm") && isTerminalAddress("terminal:tmux"));
  assert.ok(!isTerminalAddress("mobile:pailot"));
});
