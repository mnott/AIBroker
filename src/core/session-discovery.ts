/**
 * core/session-discovery.ts — one answer to "which sessions are there".
 *
 * There were two, and they disagreed. The MCP tool enumerated live iTerm tabs
 * directly; the channel commands read `HybridSessionManager`, an in-memory
 * registry that only the PAILot gateway ever populated. So `aibroker_sessions`
 * reported eight sessions while `/s` over WhatsApp answered "No sessions" —
 * and the daemon's own handler carried the comment
 *
 *     manager.listSessions() is always empty (nothing populates the registry)
 *
 * which is the defect written down and worked around rather than fixed.
 *
 * WHY THIS IS WORSE THAN A WRONG NUMBER. "No sessions" is what an empty machine
 * says, so an unpopulated registry is indistinguishable from a true answer. The
 * same shape has bitten this codebase before and been closed deliberately each
 * time: an unreadable audit log that read as an empty one, a Funnel reporting
 * itself on while refusing every connection. A reader cannot tell "none" from
 * "did not look" unless the code refuses to say "none" without looking.
 *
 * So discovery lives here, both readers call it, and nobody has to remember to
 * populate anything first. HybridManager grew its own "keep the known list on
 * a bad enumeration" guard directly; every OTHER caller of this function was
 * still getting the raw `[]` an unreadable iTerm produces. The guard belongs
 * here instead, once, so every reader inherits it.
 */

import { snapshotAllSessions, wasLastSnapshotReliable } from "../adapters/iterm/core.js";
import { getAllPersistentSessionNames, lookupPersistentName } from "./persistence.js";

export type LiveSession = ReturnType<typeof snapshotAllSessions>[0];

let lastGoodSnapshots: LiveSession[] = [];

/**
 * Live sessions, with their PAI names filled in.
 *
 * `snapshotAllSessions()` has returned `paiName: null` since 0.7.10 — the
 * authoritative source is the persistent store — so a caller that skips this
 * step gets tab titles where it expects names.
 *
 * A failed enumeration (`wasLastSnapshotReliable()` false) replays the last
 * good list instead of the `[]` iTerm hands back on an osascript fault — an
 * unreadable machine must not read as an empty one (see file header).
 */
export function discoverLiveSessions(opts: { fresh?: boolean } = {}): LiveSession[] {
  const snaps = snapshotAllSessions(opts);
  const persistentNames = getAllPersistentSessionNames();

  if (wasLastSnapshotReliable()) {
    for (const snap of snaps) {
      snap.paiName = lookupPersistentName(persistentNames, snap.id, snap.aibrokerId);
    }
    lastGoodSnapshots = snaps;
    return snaps;
  }

  return lastGoodSnapshots.map((snap) => ({
    ...snap,
    paiName: lookupPersistentName(persistentNames, snap.id, snap.aibrokerId),
  }));
}

/**
 * Is this tab something a person would call a session?
 *
 * Deliberately generous: a named tab, anything that says Claude, or anything
 * not sitting at a shell prompt. Being wrong in the inclusive direction shows
 * a row too many, which a human corrects at a glance; being wrong the other way
 * hides a session that exists, which reads as it not existing at all.
 */
export function isClaudeRelated(snap: LiveSession): boolean {
  if (snap.paiName) return true;
  const name = (snap.tabTitle ?? snap.name).toLowerCase();
  if (name.includes("claude")) return true;
  if (!snap.atPrompt) return true;
  return false;
}
