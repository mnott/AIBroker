/**
 * test/shell-injection.test.ts — writing into a shell is code execution.
 *
 * Reproduced live, twice, on this machine:
 *
 *  1. A probe question typed into a session whose claude had been suspended:
 *     zsh ran it ("zsh: no matches found: ok?").
 *  2. An ordinary status message containing a fenced code block, addressed to a
 *     project whose session had ended cleanly: substring matching resolved to
 *     the leftover shell tab in that project's directory, and zsh executed the
 *     example command inside the fence, creating a real task.
 *
 * The second is the important one. It needs no crash — every cleanly ended
 * session leaves a shell tab that keeps matching by name — and no adversarial
 * payload, because ordinary technical writing is full of backticks, which zsh
 * expands as command substitution.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isClaudeReady } from "../src/transport/screen.js";
import { writeToTty } from "../src/adapters/iterm/core.js";

const RULE = "─".repeat(60);

/** A live Claude prompt. */
const LIVE = `⏺ Ready.

${RULE} Clickr ──
❯
${RULE}
  👋 PAI CC 2.1.220 🧠 Opus 5
  💎 Context: 70K / 1000K`;

/** A cleanly ended session: `pai end` ran, the tab remains at a shell. */
const ENDED = `⏺ Session ended. Notes committed.

${RULE} Clickr ──
❯
${RULE}
  👋 PAI CC 2.1.220 🧠 Opus 5
user in hostname in …clickr on 🌿 main
✦ Sat 01 | 13:40:11 ️ ➜`;

/** A shell that never ran Claude. */
const SHELL = `user in hostname in ~/dev/ai/clickr
✦ Sat 01 | 13:40:02 ️ ➜`;

test("a live Claude prompt accepts writes", () => {
  assert.equal(isClaudeReady(LIVE), true);
});

test("a CLEANLY ENDED session is not writable — its tab is a shell", () => {
  // No crash needed. This is the state every `pai end` leaves behind, so it is
  // permanent and common rather than a transient race.
  assert.equal(isClaudeReady(ENDED), false);
});

test("a plain shell is not writable", () => {
  assert.equal(isClaudeReady(SHELL), false);
});

test("a shell prompt below the box is decisive even when the box is close", () => {
  // Position alone is not enough: right after Claude exits, its box is still
  // only a line or two above the new prompt.
  const justExited = `${RULE} Clickr ──\n❯\n${RULE}\n✦ Sat 01 | 13:40:11 ️ ➜`;
  assert.equal(isClaudeReady(justExited), false);
});

test("Claude's own status lines below the box do not look like a shell", () => {
  // The negative check must not reject healthy sessions: PAI's status line is
  // several lines of emoji and percentages directly under the box.
  const withStatus = `${RULE} Clickr ──
❯
${RULE}
  👋 PAI CC 2.1.220 🧠 Opus 5 (1M context) in 📁 clickr
  🔌 MCPs: Aibroker, Coogle, Devonthink, Dtp, Hook
  💎 Context: 150K / 1000K (65%) │ 5h: 19% → 16:39
  -- INSERT -- ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents`;
  assert.equal(isClaudeReady(withStatus), true);
});

test("an empty or unreadable frame is not writable", () => {
  // Unreadable must not be treated as safe: refusing a legitimate send is
  // recoverable, executing a message in a shell is not.
  assert.equal(isClaudeReady(""), false);
  assert.equal(isClaudeReady("   \n  \n"), false);
});

/**
 * The guard above decides WHETHER to write. These decide HOW, and the two used
 * to disagree: writeToTty built `sh -c "printf '%s\n' '<text>' > <ttyPath>"`
 * with the path interpolated unquoted, so a path only had to start with
 * /dev/ttys to pass the check and could carry a command after that.
 */
test("a tty path carrying a shell command is refused, not executed", () => {
  const marker = join(tmpdir(), "aibroker-tty-injection-probe");
  rmSync(marker, { force: true });

  // Under the old `sh -c … > ${ttyPath}`, this passed startsWith("/dev/ttys")
  // and `touch` ran.
  assert.equal(writeToTty(`/dev/ttys000; touch ${marker}`, "hello"), false);
  assert.equal(existsSync(marker), false, "the path must never reach a shell");

  rmSync(marker, { force: true });
});

test("only a bare tty device path is accepted", () => {
  for (const bad of [
    "/dev/ttys000 && id",
    "/dev/ttys000`id`",
    "/dev/ttys000$(id)",
    "/dev/ttys000/../../etc/passwd",
    "/dev/ttys000 /dev/ttys001",
    "/etc/passwd",
    "",
  ]) {
    assert.equal(writeToTty(bad, "hello"), false, `accepted ${JSON.stringify(bad)}`);
  }
});

test("a payload that is merely documentation is still executable", () => {
  // Not a code path — a statement of why the guard cannot rely on the content
  // being harmless. Backticks are command substitution in zsh.
  const ordinaryMessage = [
    "Here is how to file it:",
    "```",
    "pai task add 'Title' --owner clickr",
    "```",
  ].join("\n");
  assert.ok(ordinaryMessage.includes("```"), "routine technical writing carries fences");
  assert.equal(isClaudeReady(SHELL), false, "so the target must be checked, not the text");
});
