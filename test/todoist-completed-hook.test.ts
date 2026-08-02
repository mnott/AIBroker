/**
 * test/todoist-completed-hook.test.ts — doing something when a box is ticked.
 *
 * Completion dispatches nothing, deliberately. But the comment thread on a
 * ticked task leaves every list at that moment, and PAI archives it — on the
 * path where a session ran `pai task done`, and NOT on the path where someone
 * taps a checkbox on a phone. This hook covers the second.
 *
 * The exit code is the contract. A hook that fails quietly turns "recorded, no
 * action taken" into a claim about something that did not happen.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { runCompletedHook } = await import("../src/daemon/todoist-completed-hook.js");

function withHook(cmd: string | undefined, fn: () => Promise<void>): Promise<void> {
  const prev = process.env.TODOIST_ON_COMPLETED;
  if (cmd === undefined) delete process.env.TODOIST_ON_COMPLETED;
  else process.env.TODOIST_ON_COMPLETED = cmd;
  return fn().finally(() => {
    if (prev === undefined) delete process.env.TODOIST_ON_COMPLETED;
    else process.env.TODOIST_ON_COMPLETED = prev;
  });
}

test("no hook configured does nothing and reports so", async () => {
  await withHook(undefined, async () => {
    const r = await runCompletedHook("t-1");
    assert.deepEqual(r, { ran: false, ok: true });
  });
});

test("a successful hook reports ran and ok", async () => {
  await withHook("/usr/bin/true {taskId}", async () => {
    const r = await runCompletedHook("t-1");
    assert.equal(r.ran, true);
    assert.equal(r.ok, true);
  });
});

test("a non-zero exit is a failure, not a success", async () => {
  // `pai task archive` exits non-zero when it saved nothing. Treating that as
  // success would record "archived" for a discussion that was lost.
  await withHook("/usr/bin/false {taskId}", async () => {
    const r = await runCompletedHook("t-1");
    assert.equal(r.ran, true);
    assert.equal(r.ok, false);
    assert.match(r.detail ?? "", /exit 1/);
  });
});

test("the task id is substituted, not appended", async () => {
  // /usr/bin/test 6h9x = 6h9x exits 0 only if the substitution happened.
  await withHook("/bin/test {taskId} = 6h9x", async () => {
    assert.equal((await runCompletedHook("6h9x")).ok, true);
  });
  await withHook("/bin/test {taskId} = 6h9x", async () => {
    assert.equal((await runCompletedHook("something-else")).ok, false);
  });
});

test("a missing binary fails loudly rather than looking like success", async () => {
  await withHook("/nonexistent/pai task archive {taskId}", async () => {
    const r = await runCompletedHook("t-1");
    assert.equal(r.ran, true);
    assert.equal(r.ok, false);
  });
});

test("the command runs without a shell", async () => {
  // The task id arrives from the internet. Through a shell it would be part of
  // a command line; here `;` and backticks are just characters in an argument.
  await withHook("/bin/test {taskId} = x;whoami", async () => {
    const r = await runCompletedHook("x;whoami");
    assert.equal(r.ok, true, "the id was compared literally, not interpreted");
  });
});

test("an empty task id skips the hook rather than running it bare", async () => {
  await withHook("/usr/bin/false {taskId}", async () => {
    assert.deepEqual(await runCompletedHook(""), { ran: false, ok: true });
  });
});
