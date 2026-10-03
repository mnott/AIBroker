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
  runItermJxa,
  snapshotAllSessions,
  typeIntoSession,
  withSessionJxa,
} from "../adapters/iterm/core.js";
import type { LaunchOptions, LaunchResult, ManagedSession, SendOptions, SessionTransport, TransportKind } from "./session-transport.js";


const sq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/** Shell line typed into a fresh tab. `resume` is the PAI-style restore start. */
export function itermLaunchLine(opts: LaunchOptions): string {
  if (!opts.resume) return `cd ${sq(opts.dir)} && claude`;
  const ansiC = opts.name.replace(/'/g, "");
  const prompt = `$'/Name ${ansiC}'`;
  return `cd ${sq(opts.dir)} && claude --name ${sq(opts.name)} --dangerously-skip-permissions ${prompt}`;
}

export class ItermTransport implements SessionTransport {
  readonly kind: TransportKind = "iterm";

  isAvailable(): boolean {
    const out = runItermJxa('return String(app.windows().length);');
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
    return runItermJxa(withSessionJxa(id, "          return aSession.text();"));
  }

  isBusy(id: string): boolean {
    return isClaudeRunningInSession(id);
  }

  setTitle(id: string, title: string): boolean {
    const script = withSessionJxa(
      id,
      `          aSession.name = ${JSON.stringify(title)};\n          return "ok";`,
      '"not_found"',
    );
    const ok = runItermJxa(script) === "ok";
    if (!ok) log(`iterm setTitle: failed for ${id}`);
    return ok;
  }

  launch(opts: LaunchOptions): LaunchResult | null {
    // Same literal rules as the AppleScript it replaces: only `"` is escaped, so `\\\\n` in the line reaches the shell as `\\n`.
    const esc = itermLaunchLine(opts).replace(/"/g, '\\"');
    const id = runItermJxa(`  app.activate();
  if (app.windows().length === 0) app.createWindowWithDefaultProfile();
  var newTab = app.currentWindow().createTabWithDefaultProfile();
  var session = newTab.currentSession();
  session.write({ text: "${esc}" });
  return session.id();`);
    if (!id) return null;
    return { id: id.trim(), transport: this.kind, where: "new iTerm2 tab" };
  }
}
