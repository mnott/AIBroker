/**
 * transport/iterm.ts — iTerm2 implementation of SessionTransport (synchronous).
 *
 * A thin adapter over the existing AppleScript primitives in
 * adapters/iterm/core.ts. It does NOT modify that module — it wraps it so the
 * current behaviour is preserved exactly while exposing the transport-agnostic
 * shape. The daemon reaches these through transport/sync-facade.ts; for the
 * iTerm path the facade calls core.ts directly, so this wrapper is mainly used
 * by the selector and to prove the abstraction against both hosts.
 */

import { log } from "../core/log.js";
import {
  isClaudeRunningInSession,
  pasteTextIntoSession,
  runAppleScript,
  snapshotAllSessions,
  typeIntoSession,
  withSessionAppleScript,
} from "../adapters/iterm/core.js";
import type { LaunchOptions, LaunchResult, ManagedSession, SendOptions, SessionTransport, TransportKind } from "./session-transport.js";

function escapeForAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

const sq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/** Shell line typed into a fresh tab. `resume` is the PAI-style restore start. */
export function itermLaunchLine(opts: LaunchOptions): string {
  if (!opts.resume) return `cd ${sq(opts.dir)} && claude`;
  const ansiC = opts.name.replace(/'/g, "");
  const prompt = `$'/Name ${ansiC}\\\\ngo'`; // \\n survives AppleScript literal -> \n -> zsh newline
  return `cd ${sq(opts.dir)} && claude --name ${sq(opts.name)} --dangerously-skip-permissions ${prompt}`;
}

export class ItermTransport implements SessionTransport {
  readonly kind: TransportKind = "iterm";

  isAvailable(): boolean {
    const out = runAppleScript('tell application "iTerm2" to count windows');
    return out != null && /^\d+$/.test(out.trim());
  }

  listSessions(): ManagedSession[] {
    // paiName merge is intentionally left to the persistent-store layer above;
    // here we surface raw host data (tabTitle over process name).
    return snapshotAllSessions().map((s) => ({
      id: s.id,
      name: s.tabTitle ?? s.name,
      tabTitle: s.tabTitle,
      tty: s.tty || null,
      busy: !s.atPrompt,
      transport: this.kind,
      aibrokerId: s.id, // iTerm GUIDs are already stable across restarts.
    }));
  }

  sendText(id: string, text: string, opts: SendOptions = {}): boolean {
    const { enter = true } = opts;
    // verify/maxRetries are tmux-specific; iTerm path is best-effort as before.
    return enter ? typeIntoSession(id, text) : pasteTextIntoSession(id, text);
  }

  capture(id: string): string | null {
    const script = withSessionAppleScript(id, "          return (text of aSession)", 'return ""');
    return runAppleScript(script);
  }

  isBusy(id: string): boolean {
    return isClaudeRunningInSession(id);
  }

  setTitle(id: string, title: string): boolean {
    const script = withSessionAppleScript(
      id,
      `          set name of aSession to "${escapeForAppleScript(title)}"\n          return "ok"`,
      'return "not_found"'
    );
    const ok = runAppleScript(script) === "ok";
    if (!ok) log(`iterm setTitle: failed for ${id}`);
    return ok;
  }

  launch(opts: LaunchOptions): LaunchResult | null {
    const esc = itermLaunchLine(opts).replace(/"/g, '\\"');
    const id = runAppleScript(`tell application "iTerm2"
  activate
  if (count of windows) = 0 then create window with default profile
  tell current window
    set newTab to (create tab with default profile)
    tell current session of newTab
      write text "${esc}"
      return id of it
    end tell
  end tell
end tell`);
    if (!id) return null;
    return { id: id.trim(), transport: this.kind, where: "new iTerm2 tab" };
  }
}
