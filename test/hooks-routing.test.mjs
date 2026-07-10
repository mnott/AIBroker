/**
 * hooks-routing.test.mjs — decision-logic tests for the channel-routing hooks.
 * Pure logic only (no IPC / no delivery). Run: node --test test/hooks-routing.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findLastHumanPrompt, detectChannel, scanReplyTools, lastAssistantText,
} from "../hooks/aibroker-hook-lib.mjs";

// Build a JSONL transcript from message objects.
const user = (content) => JSON.stringify({ type: "user", message: { role: "user", content } });
const asst = (content) => JSON.stringify({ type: "assistant", message: { role: "assistant", content } });
const txt = (t) => ({ type: "text", text: t });
const tool = (name) => ({ type: "tool_use", name, input: {} });
const toolResult = (t) => ({ type: "tool_result", tool_use_id: "x", content: t });

// Replicate the guard's decision for a set of lines.
function decide(lines) {
  const prompt = findLastHumanPrompt(lines);
  if (!prompt) return { action: "noop", reason: "no-prompt" };
  const chan = detectChannel(prompt.blocks);
  if (!chan) return { action: "noop", reason: "terminal" };
  if (chan.channel !== "pailot") return { action: "noop", reason: "out-of-scope" };
  const { tts, send } = scanReplyTools(lines, prompt.index);
  const answered = chan.voice ? tts : (send || tts);
  if (answered) return { action: "noop", reason: "answered" };
  const answer = lastAssistantText(lines, prompt.index);
  if (!answer) return { action: "noop", reason: "no-answer" };
  return { action: "deliver", voice: chan.voice, answer };
}

test("voice unanswered → deliver voice", () => {
  const lines = [
    user("[PAILot:voice] what is the capital of France"),
    asst([txt("The capital of France is Paris.")]),
  ];
  const d = decide(lines);
  assert.equal(d.action, "deliver");
  assert.equal(d.voice, true);
  assert.match(d.answer, /Paris/);
});

test("voice answered via pailot_tts → noop", () => {
  const lines = [
    user("[PAILot:voice] hi"),
    asst([txt("ok"), tool("mcp__aibroker__pailot_tts")]),
  ];
  assert.equal(decide(lines).reason, "answered");
});

test("voice answered only via pailot_send (text) → still deliver voice", () => {
  const lines = [
    user("[PAILot:voice] hi"),
    asst([txt("hi there"), tool("mcp__aibroker__pailot_send")]),
  ];
  const d = decide(lines);
  assert.equal(d.action, "deliver");
  assert.equal(d.voice, true);
});

test("text PAILot answered via pailot_send → noop", () => {
  const lines = [
    user("[PAILot] hi"),
    asst([txt("hi"), tool("mcp__aibroker__pailot_send")]),
  ];
  assert.equal(decide(lines).reason, "answered");
});

test("terminal (no prefix) → noop", () => {
  const lines = [user("what is 2+2"), asst([txt("4")])];
  assert.equal(decide(lines).reason, "terminal");
});

test("token mentioned mid-sentence at terminal → noop (anchored)", () => {
  const lines = [
    user("please explain how [PAILot:voice] routing works in aibroker"),
    asst([txt("It works like this...")]),
  ];
  assert.equal(decide(lines).reason, "terminal");
});

test("most-recent prompt wins — old PAILot answered, new terminal → noop", () => {
  const lines = [
    user("[PAILot:voice] earlier question"),
    asst([txt("earlier"), tool("mcp__aibroker__pailot_tts")]),
    user("now a plain terminal question"),
    asst([txt("terminal answer")]),
  ];
  assert.equal(decide(lines).reason, "terminal");
});

test("tool_result user entries are skipped when finding the prompt", () => {
  const lines = [
    user("[PAILot:voice] do deep research"),
    asst([tool("Task")]),
    user([toolResult("agent output blob")]),
    asst([txt("Here is the researched answer.")]),
  ];
  const d = decide(lines);
  assert.equal(d.action, "deliver");
  assert.equal(d.voice, true);
  assert.match(d.answer, /researched answer/);
});

test("detectChannel handles leading whitespace/newline", () => {
  assert.deepEqual(detectChannel(["\n  [PAILot:voice] hey"]), { channel: "pailot", voice: true });
  assert.deepEqual(detectChannel(["[PAILot] yo"]), { channel: "pailot", voice: false });
  assert.deepEqual(detectChannel(["[Telex:voice] hallo"]), { channel: "telex", voice: true });
  assert.equal(detectChannel(["no prefix here"]), null);
});

test("array content prompt with text block is detected", () => {
  const lines = [
    user([txt("[PAILot:voice] tell me a joke")]),
    asst([txt("Why did the chicken...")]),
  ];
  const d = decide(lines);
  assert.equal(d.action, "deliver");
  assert.equal(d.voice, true);
});
