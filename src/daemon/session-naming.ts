/**
 * The iTerm half of naming a session: persistent name (with the one-live-holder
 * claim), cwd project, session variable, tab title and badge.
 *
 * Shared by the `rename` handler and by dispatch, so a session spawned for a
 * work order carries the same visuals as one named through the Name skill.
 * Types nothing into the session.
 */
import { setPersistentSessionName, setSessionProject } from "../core/persistence.js";
import { setItermSessionVar, setItermTabName, setItermBadge } from "../adapters/iterm/sessions.js";
import { log } from "../core/log.js";

export interface NameClaim { ok: boolean; heldBy?: string }

/** Claim `name` for the session and persist it. Surfaces are untouched on refusal. */
export function claimItermSessionName(itermSessionId: string, name: string, cwd?: string | null): NameClaim {
  const claim = setPersistentSessionName(itermSessionId, name);
  if (!claim.ok) return claim;
  setSessionProject(itermSessionId, cwd);
  return claim;
}

/** Set the visible iTerm surfaces: session variable, tab title, badge. */
export function applyItermVisuals(itermSessionId: string, name: string): void {
  setItermSessionVar(itermSessionId, name);
  setItermTabName(itermSessionId, name);
  setItermBadge(itermSessionId, name);
}

/**
 * Claim + persist + visuals for a freshly spawned session. Never throws:
 * a failure is logged, because naming must not fail the dispatch.
 */
export function nameSpawnedSession(itermSessionId: string, name: string, cwd?: string): void {
  try {
    const claim = claimItermSessionName(itermSessionId, name, cwd);
    if (!claim.ok) {
      log(`dispatch: name "${name}" held by live session ${claim.heldBy?.slice(0, 8)}; visuals not set for ${itermSessionId.slice(0, 8)}`);
      return;
    }
    applyItermVisuals(itermSessionId, name);
  } catch (err) {
    log(`dispatch: could not set session visuals for ${itermSessionId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
