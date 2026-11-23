/**
 * core/native-peers.ts — which listed sessions Claude Code can message itself.
 *
 * Claude Code (interactive) writes ~/.claude/sessions/<pid>.json with a
 * `messagingSocketPath` and `peerProtocol` when it accepts cross-session
 * messages (SendMessage). AIBroker only reports this (path A of the hybrid
 * messaging design); it never connects to the socket.
 *
 * native: true  — registry entry for that claude session is interactive, its
 *                 pid is alive, and it has messagingSocketPath + peerProtocol;
 *                 also when it cannot be known (no claude session id, registry
 *                 dir unreadable) — learn from SendMessage failures instead.
 * native: false — not a Claude Code session, or the registry says no (entry
 *                 missing, dead pid, background kind, no socket/protocol).
 */

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function claudeSessionsDir(home: string = homedir()): string {
  return join(home, ".claude", "sessions");
}

export interface ClaudeRegistryEntry {
  pid: number;
  sessionId: string;
  kind?: string;
  messagingSocketPath?: string;
  peerProtocol?: number;
}

/** undefined when the directory cannot be read ("did not look" is not "none"). */
export function readClaudeRegistry(dir: string = claudeSessionsDir()): ClaudeRegistryEntry[] | undefined {
  let files: string[];
  try { files = readdirSync(dir); } catch { return undefined; }
  const out: ClaudeRegistryEntry[] = [];
  for (const f of files) {
    if (!/^\d+\.json$/.test(f)) continue;
    try {
      const j = JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>;
      if (typeof j.pid !== "number" || typeof j.sessionId !== "string") continue;
      out.push({
        pid: j.pid,
        sessionId: j.sessionId,
        kind: typeof j.kind === "string" ? j.kind : undefined,
        messagingSocketPath: typeof j.messagingSocketPath === "string" ? j.messagingSocketPath : undefined,
        peerProtocol: typeof j.peerProtocol === "number" ? j.peerProtocol : undefined,
      });
    } catch { /* another program's file; skip */ }
  }
  return out;
}

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

export interface NativeOpts {
  registry?: ClaudeRegistryEntry[] | undefined;
  isAlive?: (pid: number) => boolean;
}

/** Is a Claude Code session with this id reachable via SendMessage? `registry` undefined = unknown. */
export function isNativePeer(claudeSessionId: string | undefined, opts: NativeOpts): boolean {
  if (!claudeSessionId || !opts.registry) return true;
  const alive = opts.isAlive ?? pidAlive;
  const e = opts.registry.find((r) => r.sessionId === claudeSessionId);
  if (!e) return false;
  return e.kind === "interactive" && Boolean(e.messagingSocketPath) && e.peerProtocol !== undefined && alive(e.pid);
}
