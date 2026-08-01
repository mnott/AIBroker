/**
 * test/exited-session-safety.test.ts — never type into a shell.
 *
 * When Claude exits, crashes or is suspended, its entire UI stays in the
 * terminal's scrollback and a shell prompt appears underneath. The session
 * keeps its PAI name, so it still matches by project — but the tty now belongs
 * to zsh, and zsh EXECUTES what it is sent.
 *
 * Observed for real: after SIGSTOPing a session's claude process, a probe
 * question was typed into the recovered shell and ran as a command
 * ("zsh: no matches found: ok?"). A dispatched task body is multi-line and full
 * of backticks, so the same path would run fragments of a task description.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { isClaudeReady } from "../src/daemon/terminal-screen.js";
import { dispatch, type DispatchDeps } from "../src/daemon/dispatch.js";
import { ask, type AskDeps } from "../src/daemon/ask.js";
import type { PaiProject } from "../src/daemon/pai-projects.js";

const RULE = "─".repeat(60);

/** A live Claude prompt: box at the bottom, only status lines below it. */
const LIVE = `⏺ Done.

${RULE} coogle ──
❯
${RULE}
  👋 PAI CC 2.1.220 🧠 Opus 5 (1M context) in 📁 coogle
  🔌 MCPs: Aibroker, Coogle, Devonthink
  💎 Context: 70K / 1000K (73%)
  -- INSERT -- ⏵⏵ bypass permissions on (shift+tab to cycle)`;

/**
 * Captured verbatim from the session whose claude I suspended. Claude's box is
 * still on screen; the shell owns the tty underneath it.
 */
const EXITED = `❯ Status probe from the AIBroker scheduler. Reply with one short sentence.
  ⎿  1 skill available
⏺ [2026-08-01 00:0x] Idle — no work in progress, coogle repo clean at v0.2.23.
✻ Churned for 11s
${RULE} coogle ──
❯
[1]  + 65928 suspended (tty input)  ${RULE}
i052341 in  HKP9MJXWJY in …coogle on 🌿 main is 📦 v0.2.23 via 🥟 v1.3.5
✦ Sat 01 | 13:17:08 ️ ➜ Post-test check: one word reply please — ok?
zsh: no matches found: ok?
i052341 in  HKP9MJXWJY in …coogle on 🌿 main is 📦 v0.2.23 via 🥟 v1.3.5
✦ Sat 01 | 13:17:09 ️ ❌1 ✗
i052341 in  HKP9MJXWJY in …coogle on 🌿 main is 📦 v0.2.23 via 🥟 v1.3.5
✦ Sat 01 | 13:17:09 ️ ➜`;

/** A plain shell that never ran Claude. */
const SHELL = `i052341 in HKP9MJXWJY in ~/dev/ai/coogle
Sat 01 | 13:18:02 ️ ➜`;

test("a live Claude prompt is ready", () => {
  assert.equal(isClaudeReady(LIVE), true);
});

test("a session whose Claude exited is NOT ready, despite its UI in scrollback", () => {
  // The regression: a frame-wide search finds the rules and the caret here.
  assert.equal(isClaudeReady(EXITED), false);
});

test("a bare shell is not ready", () => {
  assert.equal(isClaudeReady(SHELL), false);
});

test("dispatch refuses to deliver into a shell", async () => {
  let sent = false;
  const deps: DispatchDeps = {
    resolve: async (): Promise<PaiProject> => ({
      name: "coogle", names: ["coogle"], slug: "coogle", displayName: "coogle",
      rootPath: "/coogle", sessionCount: 0, lastActive: "",
    }),
    sessions: () => [{ id: "S1", name: "coogle", paiName: "coogle" }],
    deliver: async () => { sent = true; return "ok"; },
    launch: async () => { throw new Error("must not launch"); },
    waitReady: async () => true,
    capture: () => EXITED,
    now: () => 0,
  };

  const r = await dispatch("coogle", "run `npm test` and report", {}, deps);
  assert.equal(r.outcome, "unreachable");
  assert.equal(sent, false, "a shell would have executed this");
  assert.match(r.reason!, /shell/);
});

test("dispatch still delivers to a healthy session", async () => {
  let sent = false;
  const deps: DispatchDeps = {
    resolve: async (): Promise<PaiProject> => ({
      name: "coogle", names: ["coogle"], slug: "coogle", displayName: "coogle",
      rootPath: "/coogle", sessionCount: 0, lastActive: "",
    }),
    sessions: () => [{ id: "S1", name: "coogle", paiName: "coogle" }],
    deliver: async () => { sent = true; return "ok"; },
    launch: async () => { throw new Error("must not launch"); },
    waitReady: async () => true,
    capture: () => LIVE,
    now: () => 0,
  };

  const r = await dispatch("coogle", "do the thing", {}, deps);
  assert.equal(r.outcome, "delivered");
  assert.equal(sent, true);
});

test("ask refuses to question a shell", async () => {
  let sent = false;
  let clock = 0;
  const deps: AskDeps = {
    resolve: async (): Promise<PaiProject> => ({
      name: "coogle", names: ["coogle"], slug: "coogle", displayName: "coogle",
      rootPath: "/coogle", sessionCount: 0, lastActive: "",
    }),
    sessions: () => [{ id: "S1", name: "coogle", paiName: "coogle" }],
    io: {
      capture: () => EXITED,       // static, so it is not judged busy
      send: () => { sent = true; },
      sleep: async (ms) => { clock += ms; },
      now: () => clock,
    },
  };

  const r = await ask("coogle", "are you alive?", {}, deps);
  assert.equal(r.state, "silent");
  assert.equal(sent, false, "zsh would have run the question as a command");
  assert.match(r.reason!, /not showing a Claude prompt/);
});
