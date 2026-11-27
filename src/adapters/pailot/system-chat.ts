/** Daemon alerts have no session; the hub publishes them on "global", shown as the System chat. */
export const SYSTEM_SESSION_ID = "global";
export const SYSTEM_SESSION_NAME = "System";

export function pushRouting(resolvedSession: string | undefined): { sessionId: string; isSystem: boolean } {
  return resolvedSession
    ? { sessionId: resolvedSession, isSystem: false }
    : { sessionId: SYSTEM_SESSION_ID, isSystem: true };
}
