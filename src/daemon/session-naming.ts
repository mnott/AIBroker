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
export async function claimItermSessionName(itermSessionId: string, name: string, cwd?: string | null): Promise<NameClaim> {
  const claim = await setPersistentSessionName(itermSessionId, name);
  if (!claim.ok) return claim;
  setSessionProject(itermSessionId, cwd);
  return claim;
}

/** Set the visible iTerm surfaces: session variable, tab title, badge. */
export async function applyItermVisuals(itermSessionId: string, name: string): Promise<void> {
  await setItermSessionVar(itermSessionId, name);
  setItermTabName(itermSessionId, name);
  await setItermBadge(itermSessionId, name);
}

/**
 * Claim + persist + visuals for a freshly spawned session. Never throws:
 * a failure is logged, because naming must not fail the dispatch.
 */
export async function nameSpawnedSession(itermSessionId: string, name: string, cwd?: string): Promise<void> {
  try {
    const claim = await claimItermSessionName(itermSessionId, name, cwd);
    if (!claim.ok) {
      log(`dispatch: name "${name}" held by live session ${claim.heldBy?.slice(0, 8)}; visuals not set for ${itermSessionId.slice(0, 8)}`);
      return;
    }
    await applyItermVisuals(itermSessionId, name);
  } catch (err) {
    log(`dispatch: could not set session visuals for ${itermSessionId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
