/**
 * daemon/ingress.ts — who may put text on a Claude session's input line.
 *
 * The operator's own channels (Telex, Whazaa, PAILot — `!`-prefixed or not) are
 * the operator typing: they cannot be typing in parallel at the terminal, so
 * those messages go to the input line. Everything else is machine ingress
 * (Todoist, forge/GitHub events, worker alerts, other sessions, A2A): it is
 * stored in the session's mailbox and nothing is typed, so it can never land in
 * a sentence the operator is writing. An idle session is woken by its
 * `aibroker mailbox wait`; a busy one reads the mailbox at its next prompt.
 *
 * One table, one function. A source that is not listed is machine ingress.
 */

/** `pointer`: mailbox plus the idle-only one-line pointer (no waiter to wake the session). */
export type Delivery = "type" | "mailboxOnly" | "pointer";

const INGRESS_DELIVERY: Record<string, "type" | "machine"> = {
  // The operator's own channels.
  telex: "type",
  telegram: "type",
  whazaa: "type",
  whatsapp: "type",
  pailot: "type",
  // Machine ingress.
  todoist: "machine",
  forge: "machine",
  github: "machine",
  inbound: "machine",
  a2a: "machine",
  worker: "machine",
  session: "machine",
};

/**
 * How a message from `source` reaches a session. The operator's channels type.
 * Machine ingress (and any unknown source) is mailbox-only when the session has
 * an active `aibroker mailbox wait` to wake it, else mailbox plus the idle-only
 * pointer so an idle session without a waiter still notices it.
 */
export function deliveryFor(source: string | undefined, hasWaiter = false): Delivery {
  const hit = INGRESS_DELIVERY[(source ?? "").toLowerCase()];
  if (hit === "type") return "type";
  return hasWaiter ? "mailboxOnly" : "pointer";
}
