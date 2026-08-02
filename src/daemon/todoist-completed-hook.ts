/**
 * daemon/todoist-completed-hook.ts — running something when a task is ticked.
 *
 * Completion is the one event with nothing downstream: the receiver records it
 * and deliberately never acts, because "done" must not start work. But recording
 * is not the same as ignoring, and there is a real thing to do at that moment —
 * PAI archives the task's comment thread, which otherwise leaves every list the
 * instant the box is ticked and is gone.
 *
 * A CONFIGURED COMMAND rather than a hardcoded one. AIBroker is the runtime and
 * PAI is a consumer of it; wiring `pai task archive` into the receiver would
 * invert that and make this file useless to anyone not running PAI. The hook is
 * unset by default, so nothing changes for an installation that wants nothing.
 *
 * The exit code is the whole point of the contract. A hook that fails silently
 * turns "recorded, no action taken" into a claim about something that did not
 * happen — which is the defect this codebase keeps closing, reintroduced at the
 * one place that reports on it.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log } from "../core/log.js";

const execFileAsync = promisify(execFile);

/** Long enough for a network round trip, short enough not to stall the receiver. */
const HOOK_TIMEOUT_MS = 30_000;

export interface HookResult {
  ran: boolean;
  ok: boolean;
  detail?: string;
}

/**
 * Run `TODOIST_ON_COMPLETED`, substituting `{taskId}`.
 *
 * The command is split on whitespace and executed WITHOUT a shell: this runs on
 * a task id that came from the internet, and a shell would make that id part of
 * a command line. The daemon's PATH is `/usr/local/bin:/usr/bin:/bin` under
 * launchd — no Homebrew — so anything outside that must be given absolutely.
 */
export async function runCompletedHook(taskId: string): Promise<HookResult> {
  const template = process.env.TODOIST_ON_COMPLETED?.trim();
  if (!template) return { ran: false, ok: true };
  if (!taskId) return { ran: false, ok: true };

  const parts = template.split(/\s+/).map((p) => p.replace("{taskId}", taskId));
  const [bin, ...args] = parts;
  if (!bin) return { ran: false, ok: true };

  try {
    await execFileAsync(bin, args, { timeout: HOOK_TIMEOUT_MS, env: { ...process.env } });
    return { ran: true, ok: true };
  } catch (e) {
    // execFile rejects on a non-zero exit, which is exactly the signal wanted:
    // the hook is expected to fail loudly when it saved nothing.
    const err = e as { code?: number | string; stderr?: string; message?: string };
    const detail = (err.stderr?.trim() || err.message || String(e)).slice(0, 200);
    log(`todoist-completed-hook: ${bin} exited ${err.code ?? "?"} — ${detail}`);
    return { ran: true, ok: false, detail: `exit ${err.code ?? "?"}: ${detail}` };
  }
}
