/**
 * daemon/mailbox-watch.ts — a queued message that never gets read is not queued.
 *
 * `send_to_session` now says "queued" when it could not confirm the target took
 * the message, which is honest at the moment of sending. It stops being honest
 * with time. A message queued at 14:00 and still undrained at 18:00 is not
 * pending — it is lost, and an audit trail that still calls it "queued" is a
 * silent failure wearing a truthful label. That is harder to spot than an
 * obvious lie, because nothing looks wrong.
 *
 * So every state that can persist has to know how long it has been in that
 * state. The mailbox already stamps each message; this is the thing that looks.
 */

import { listSessionMailboxes, type MailboxMessage } from "../core/state.js";
import { audit } from "./audit.js";
import { log } from "../core/log.js";

/** How long a message may sit undrained before it is a fault rather than a wait. */
export const STALE_AFTER_MS = 15 * 60 * 1000;

/** How often to look. Cheap: an in-memory scan of a bounded map. */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

let timer: NodeJS.Timeout | undefined;

/**
 * Report messages that have outlived "queued".
 *
 * Exported for tests and callable directly; `now` is injected so ageing can be
 * exercised without waiting a quarter of an hour.
 */
export function sweepStaleMailboxes(now: number = Date.now()): MailboxMessage[] {
  const stale: MailboxMessage[] = [];
  for (const { sessionId, messages } of listSessionMailboxes()) {
    for (const m of messages) {
      if (m.staleReported) continue;
      const waited = now - m.timestamp;
      if (waited < STALE_AFTER_MS) continue;
      m.staleReported = true;
      stale.push(m);
      audit({
        action: "send", actor: `session:${m.from}`, target: sessionId,
        outcome: "stale", body: m.content,
        reason: `undrained for ${Math.round(waited / 60000)} min — reported queued, never read`,
      });
      log(`mailbox-watch: message from ${m.from} to ${sessionId} undrained for ${Math.round(waited / 60000)} min`);
    }
  }
  return stale;
}

export function startMailboxWatch(): void {
  if (timer) return;
  timer = setInterval(() => {
    try {
      sweepStaleMailboxes();
    } catch (e) {
      log(`mailbox-watch: sweep failed — ${e instanceof Error ? e.message : String(e)}`);
    }
    // Same housekeeping tick, same principle: a state that can persist has to
    // know how long it has been in that state. A trigger claimed by a run that
    // died is a routine that has silently stopped.
    void (async () => {
      try {
        const { sweepAbandonedClaims } = await import("./todoist-claims.js");
        const { setTaskLabel } = await import("./todoist-reply.js");
        const { RUNNING_LABEL } = await import("./todoist-webhook.js");
        await sweepAbandonedClaims((taskId) => setTaskLabel(taskId, RUNNING_LABEL, false).then(() => undefined));
      } catch (e) {
        log(`mailbox-watch: claim sweep failed — ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
  }, SWEEP_INTERVAL_MS);
  // Never hold the process open for a housekeeping timer.
  timer.unref?.();
  log(`mailbox-watch: watching for messages undrained after ${STALE_AFTER_MS / 60000} min`);
}

export function stopMailboxWatch(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
