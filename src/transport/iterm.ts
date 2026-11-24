/**
 * transport/iterm.ts — iTerm2 implementation of SessionTransport (async).
 *
 * A thin adapter over the existing AppleScript primitives in
 * adapters/iterm/core.ts, which are all awaited children now — nothing here may
 * block the event loop. The daemon reaches these through transport/sync-facade.ts;
 * for the iTerm path the facade calls core.ts directly, so this wrapper is mainly
 * used by the selector and to prove the abstraction against both hosts.
 */

import { log } from "../core/log.js";
import { resolveLaunchDir } from "../core/launch-dir.js";
import {
  isClaudeRunningInSession,
  pasteTextIntoSession,
  _internal,
  snapshotAllSessions,
  typeIntoSession,
  withSessionJxa,
} from "../adapters/iterm/core.js";

// Every call goes through _internal, so a test that swaps
// `_internal.runItermJxa` changes what this transport actually runs — a direct
// import binds the original function once at load and silently keeps it.
const runItermJxa = (body: string, timeoutMs?: number): Promise<string | null> => _internal.runItermJxa(body, timeoutMs);
import type { LaunchOptions, LaunchResult, ManagedSession, SendOptions, SessionTransport, TransportKind } from "./session-transport.js";


const sq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

/** Shell line typed into a fresh tab. `resume` is the PAI-style restore start. */
export function itermLaunchLine(opts: LaunchOptions): string {
  const dir = resolveLaunchDir(opts.dir);
  if (!opts.resume) return `cd ${sq(dir)} && claude`;
  const ansiC = opts.name.replace(/'/g, "");
  const prompt = `$'/Name ${ansiC}'`;
  return `cd ${sq(dir)} && claude --name ${sq(opts.name)} --dangerously-skip-permissions ${prompt}`;
}

export class ItermTransport implements SessionTransport {
  readonly kind: TransportKind = "iterm";

  async isAvailable(): Promise<boolean> {
    const out = await runItermJxa('return String(app.windows().length);');
    return out != null && /^\d+$/.test(out.trim());
  }

  async listSessions(): Promise<ManagedSession[]> {
    // paiName merge is intentionally left to the persistent-store layer above;
    // here we surface raw host data (tabTitle over process name).
    return (await snapshotAllSessions()).map((s) => ({
      id: s.id,
      name: s.tabTitle ?? s.name,
      tabTitle: s.tabTitle,
      tty: s.tty || null,
      busy: !s.atPrompt,
      transport: this.kind,
      aibrokerId: s.id, // iTerm GUIDs are already stable across restarts.
    }));
  }

  async sendText(id: string, text: string, opts: SendOptions = {}): Promise<boolean> {
    const { enter = true } = opts;
    // verify/maxRetries are tmux-specific; iTerm path is best-effort as before.
    return enter ? typeIntoSession(id, text) : pasteTextIntoSession(id, text);
  }

  async capture(id: string): Promise<string | null> {
    return runItermJxa(withSessionJxa(id, "          return aSession.text();"));
  }

  async isBusy(id: string): Promise<boolean> {
    return isClaudeRunningInSession(id);
  }

  async setTitle(id: string, title: string): Promise<boolean> {
    const script = withSessionJxa(
      id,
      `          aSession.name = ${JSON.stringify(title)};\n          return "ok";`,
      '"not_found"',
    );
    const ok = (await runItermJxa(script)) === "ok";
    if (!ok) log(`iterm setTitle: failed for ${id}`);
    return ok;
  }

  async launch(opts: LaunchOptions): Promise<LaunchResult | null> {
    // Same literal rules as the AppleScript it replaces: only `"` is escaped, so `\\\\n` in the line reaches the shell as `\\n`.
    const esc = itermLaunchLine(opts).replace(/"/g, '\\"');
    const id = await runItermJxa(`  app.activate();
  if (app.windows().length === 0) app.createWindowWithDefaultProfile();
  var newTab = app.currentWindow().createTabWithDefaultProfile();
  var session = newTab.currentSession();
  session.write({ text: "${esc}" });
  return session.id();`);
    if (!id) return null;
    return { id: id.trim(), transport: this.kind, where: "new iTerm2 tab" };
  }
}
